import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adstationSlots,
  adstationDirectCampaigns,
  adsPromoterWebsites,
  adsPromoters,
} from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import * as crypto from 'crypto';

export interface CreateAdstationSlotDto {
  websiteId: string;
  name: string;
  slotType: 'consideration' | 'direct' | 'network' | 'hybrid';
  format?: string;
  slotDeliveryPreference?: string;
}

export interface CreateDirectCampaignDto {
  websiteId: string;
  slotId?: string;
  clientName: string;
  campaignTitle: string;
  destinationUrl: string;
  headline?: string;
  imageUrl?: string;
  videoUrl?: string;
  targetImpressions?: number;
  endsAt?: Date;
}

@Injectable()
export class AdstationService {
  private readonly logger = new Logger(AdstationService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * List slots for a promoter website
   */
  async getSlots(promoterId: string, websiteId: string) {
    return this.db
      .select()
      .from(adstationSlots)
      .where(and(eq(adstationSlots.promoterId, promoterId), eq(adstationSlots.websiteId, websiteId)))
      .orderBy(desc(adstationSlots.createdAt));
  }

  /**
   * Create an ad slot in AdStation
   * Enforces that consideration slots are flagged and track verification status.
   */
  async createSlot(promoterId: string, dto: CreateAdstationSlotDto) {
    // Verify website ownership
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(and(eq(adsPromoterWebsites.id, dto.websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .limit(1);

    if (!website) {
      throw new NotFoundException('Promoter website not found or unauthorized');
    }

    const isConsideration = dto.slotType === 'consideration';
    const tagSuffix = crypto.randomBytes(8).toString('hex');
    const slotTagId = `cf-slot-${dto.slotType}-${tagSuffix}`;

    const [slot] = await this.db
      .insert(adstationSlots)
      .values({
        promoterId,
        websiteId: dto.websiteId,
        name: dto.name,
        slotType: dto.slotType,
        format: dto.format || 'banner',
        isConsiderationSlot: isConsideration,
        isConsiderationVerified: false,
        slotDeliveryPreference: dto.slotDeliveryPreference,
        slotTagId,
        isActive: true,
      })
      .returning();

    // If marked consideration, activate consideration on website record
    if (isConsideration) {
      await this.db
        .update(adsPromoterWebsites)
        .set({
          considerationSlotActive: true,
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, dto.websiteId));
    }

    return slot;
  }

  /**
   * Verify Consideration Slot (PLAN-0018 Section 2.1)
   * Super Admin or automated crawler confirms consideration placement serves exclusively CrimFig network ads.
   */
  async verifyConsiderationSlot(promoterId: string, websiteId: string, slotId: string) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(and(eq(adstationSlots.id, slotId), eq(adstationSlots.websiteId, websiteId), eq(adstationSlots.promoterId, promoterId)))
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found');
    }

    if (!slot.isConsiderationSlot && slot.slotType !== 'consideration') {
      throw new BadRequestException('Slot is not designated as a consideration slot');
    }

    const [updatedSlot] = await this.db
      .update(adstationSlots)
      .set({
        isConsiderationVerified: true,
        considerationLastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adstationSlots.id, slotId))
      .returning();

    await this.db
      .update(adsPromoterWebsites)
      .set({
        considerationSlotActive: true,
        considerationSlotVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterWebsites.id, websiteId));

    return {
      status: 'verified',
      slot: updatedSlot,
    };
  }

  /**
   * Update Account Delivery Preference (PLAN-0018 Section 2.2)
   * High, Medium, Low allocation for CrimFig Network ads vs Direct Campaigns.
   */
  async updateDeliveryPreference(promoterId: string, websiteId: string, preference: 'high' | 'medium' | 'low') {
    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        deliveryPreference: preference,
        updatedAt: new Date(),
      })
      .where(and(eq(adsPromoterWebsites.id, websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .returning();

    if (!updated) {
      throw new NotFoundException('Website not found');
    }

    return {
      status: 'success',
      deliveryPreference: updated.deliveryPreference,
    };
  }

  /**
   * List Direct Campaigns (100% revenue to site owner; 0% CF commission)
   */
  async getDirectCampaigns(promoterId: string, websiteId?: string) {
    if (websiteId) {
      return this.db
        .select()
        .from(adstationDirectCampaigns)
        .where(and(eq(adstationDirectCampaigns.promoterId, promoterId), eq(adstationDirectCampaigns.websiteId, websiteId)))
        .orderBy(desc(adstationDirectCampaigns.createdAt));
    }

    return this.db
      .select()
      .from(adstationDirectCampaigns)
      .where(eq(adstationDirectCampaigns.promoterId, promoterId))
      .orderBy(desc(adstationDirectCampaigns.createdAt));
  }

  /**
   * Create Direct Campaign
   * Enforces: CANNOT bind direct campaign to a Consideration Slot! (PLAN-0018 Section 2.1)
   */
  async createDirectCampaign(promoterId: string, dto: CreateDirectCampaignDto) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(and(eq(adsPromoterWebsites.id, dto.websiteId), eq(adsPromoterWebsites.promoterId, promoterId)))
      .limit(1);

    if (!website) {
      throw new NotFoundException('Promoter website not found or unauthorized');
    }

    if (dto.slotId) {
      const [slot] = await this.db
        .select()
        .from(adstationSlots)
        .where(and(eq(adstationSlots.id, dto.slotId), eq(adstationSlots.promoterId, promoterId), eq(adstationSlots.websiteId, dto.websiteId)))
        .limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found or unauthorized');
      }

      if (slot.isConsiderationSlot || slot.slotType === 'consideration') {
        throw new BadRequestException('Direct deals cannot be assigned to a Consideration Slot. Consideration slots serve exclusively CrimFig network ads.');
      }
    }

    const [campaign] = await this.db
      .insert(adstationDirectCampaigns)
      .values({
        promoterId,
        websiteId: dto.websiteId,
        slotId: dto.slotId || null,
        clientName: dto.clientName,
        campaignTitle: dto.campaignTitle,
        destinationUrl: dto.destinationUrl,
        headline: dto.headline || null,
        imageUrl: dto.imageUrl || null,
        videoUrl: dto.videoUrl || null,
        targetImpressions: dto.targetImpressions || 0,
        status: 'active',
        endsAt: dto.endsAt || null,
      })
      .returning();

    return campaign;
  }

  /**
   * Record Direct Deal Ad Event with Idempotency Deduplication (PLAN-0018 Phase 3)
   * Ensures 0% platform fee and zero leak to promoter cash balance.
   */
  async recordDirectEvent(dto: {
    promoterId?: string;
    directCampaignId: string;
    websiteId: string;
    slotId?: string;
    eventType: 'impression' | 'viewable_impression' | 'click' | 'hover';
    idempotencyKey: string;
    isViewable?: boolean;
    viewDurationMs?: number;
    ipHash?: string;
    userAgent?: string;
  }) {
    if (dto.promoterId) {
      const [campaign] = await this.db
        .select()
        .from(adstationDirectCampaigns)
        .where(
          and(
            eq(adstationDirectCampaigns.id, dto.directCampaignId),
            eq(adstationDirectCampaigns.promoterId, dto.promoterId),
            eq(adstationDirectCampaigns.websiteId, dto.websiteId),
          ),
        )
        .limit(1);

      if (!campaign) {
        throw new NotFoundException('Direct campaign not found or unauthorized');
      }
    }

    // Deduplication check via unique idempotencyKey
    const existing = await this.db
      .select({ id: schema.adstationAdEvents.id })
      .from(schema.adstationAdEvents)
      .where(eq(schema.adstationAdEvents.idempotencyKey, dto.idempotencyKey))
      .limit(1);

    if (existing.length > 0) {
      return { status: 'duplicate_ignored', eventId: existing[0].id };
    }

    const [event] = await this.db
      .insert(schema.adstationAdEvents)
      .values({
        directCampaignId: dto.directCampaignId,
        websiteId: dto.websiteId,
        slotId: dto.slotId || null,
        eventType: dto.eventType,
        idempotencyKey: dto.idempotencyKey,
        isViewable: dto.isViewable ?? false,
        viewDurationMs: dto.viewDurationMs ?? 0,
        ipHash: dto.ipHash || null,
        userAgent: dto.userAgent || null,
      })
      .returning();

    // Increment aggregate counter on direct campaign
    if (dto.eventType === 'impression' || dto.eventType === 'viewable_impression') {
      const [camp] = await this.db
        .select({ delivered: adstationDirectCampaigns.deliveredImpressions })
        .from(adstationDirectCampaigns)
        .where(eq(adstationDirectCampaigns.id, dto.directCampaignId))
        .limit(1);

      if (camp) {
        await this.db
          .update(adstationDirectCampaigns)
          .set({
            deliveredImpressions: (camp.delivered || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(adstationDirectCampaigns.id, dto.directCampaignId));
      }
    } else if (dto.eventType === 'click') {
      const [camp] = await this.db
        .select({ clicks: adstationDirectCampaigns.deliveredClicks })
        .from(adstationDirectCampaigns)
        .where(eq(adstationDirectCampaigns.id, dto.directCampaignId))
        .limit(1);

      if (camp) {
        await this.db
          .update(adstationDirectCampaigns)
          .set({
            deliveredClicks: (camp.clicks || 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(adstationDirectCampaigns.id, dto.directCampaignId));
      }
    }

    return { status: 'recorded', eventId: event.id };
  }

  /**
   * Consideration Slot 48-Hour Grace State Machine (PLAN-0018 Phase 6)
   * Audits presence of verified consideration slot. If missing or broken,
   * starts/checks 48-hour grace period before automated suspension of direct deals.
   */
  async checkConsiderationSlotHealth(websiteId: string, promoterId?: string) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        promoterId
          ? and(eq(adsPromoterWebsites.id, websiteId), eq(adsPromoterWebsites.promoterId, promoterId))
          : eq(adsPromoterWebsites.id, websiteId),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    const considerationSlots = await this.db
      .select()
      .from(adstationSlots)
      .where(and(eq(adstationSlots.websiteId, websiteId), eq(adstationSlots.isConsiderationSlot, true), eq(adstationSlots.isActive, true)));

    const hasHealthyConsideration = considerationSlots.some(s => s.isConsiderationVerified);

    if (hasHealthyConsideration) {
      // Clear any past suspension warning
      if (website.considerationSlotActive === false) {
        await this.db
          .update(adsPromoterWebsites)
          .set({
            considerationSlotActive: true,
            suspensionReason: null,
            updatedAt: new Date(),
          })
          .where(eq(adsPromoterWebsites.id, websiteId));
      }
      return { status: 'healthy', considerationVerified: true, graceActive: false };
    }

    // Unhealthy: Consideration slot is absent or unverified
    // Evaluate 48-hour grace window based on verifiedAt or lastVerificationAttemptAt
    const referenceTime = website.considerationSlotVerifiedAt || website.lastVerificationAttemptAt || website.createdAt;
    const gracePeriodMs = 48 * 60 * 60 * 1000;
    const elapsedMs = Date.now() - new Date(referenceTime).getTime();
    const graceRemainingHours = Math.max(0, Math.round((gracePeriodMs - elapsedMs) / (60 * 60 * 1000)));

    if (elapsedMs > gracePeriodMs) {
      // Grace period expired: automatically suspend direct deal serving
      await this.db
        .update(adsPromoterWebsites)
        .set({
          considerationSlotActive: false,
          isSuspended: true,
          suspensionReason: 'Consideration slot requirement unfulfilled past 48-hour grace window.',
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, websiteId));

      return {
        status: 'suspended',
        considerationVerified: false,
        graceActive: false,
        graceRemainingHours: 0,
        reason: 'Consideration slot requirement unfulfilled past 48-hour grace window.',
      };
    }

    return {
      status: 'pending_review_grace',
      considerationVerified: false,
      graceActive: true,
      graceRemainingHours,
      reason: `Consideration slot unverified. Please configure tag within ${graceRemainingHours} hours to avoid suspension.`,
    };
  }

  /**
   * Super Admin Enforcement: Suspend or Reinstate Website Direct Deals (PLAN-0018 Phase 6)
   */
  async updateWebsiteAdstationStatus(websiteId: string, isSuspended: boolean, reason?: string) {
    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        isSuspended,
        suspensionReason: isSuspended ? (reason || 'Super Admin moderation action') : null,
        updatedAt: new Date(),
      })
      .where(eq(adsPromoterWebsites.id, websiteId))
      .returning();

    if (!updated) {
      throw new NotFoundException('Website not found');
    }

    return {
      status: isSuspended ? 'suspended' : 'active',
      websiteId: updated.id,
      domain: updated.domain,
      isSuspended: updated.isSuspended,
      suspensionReason: updated.suspensionReason,
    };
  }
}
