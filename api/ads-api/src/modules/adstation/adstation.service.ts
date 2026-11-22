import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adstationSlots, adstationDirectCampaigns, adsPromoterWebsites } from '@crimfig/database/schema';
import { and, eq, desc, or, sql } from 'drizzle-orm';

import { PublisherSlotsService } from '../publisher-inventory/publisher-slots.service';
import { evaluateDirectSlotReadiness } from './adstation-gating';
export type { CreateAdstationSlotDto, UpdateAdstationSlotDto } from '../publisher-inventory/publisher-slots.service';

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
export class AdstationService extends PublisherSlotsService {
  constructor(
    @Inject(DATABASE_TOKEN)
    db: NodePgDatabase<typeof schema>,
  ) { super(db); }

  /**
   * Verify Consideration Slot (PLAN-0018 Section 2.1)
   */
  async verifyConsiderationSlot(
    promoterId: string,
    websiteId: string,
    slotId: string,
  ) {
    const [slot] = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.id, slotId),
          eq(adstationSlots.websiteId, websiteId),
          eq(adstationSlots.promoterId, promoterId),
        ),
      )
      .limit(1);

    if (!slot) {
      throw new NotFoundException('AdStation slot not found');
    }

    if (!slot.isConsiderationSlot && slot.slotType !== 'consideration') {
      throw new BadRequestException(
        'Slot is not designated as a consideration slot',
      );
    }

    const result = await this.checkSlotInstallation(promoterId, slotId);
    if (!result.isInstalled) throw new BadRequestException('A recent real render receipt is required before verifying this placement.');

    return {
      status: 'verified',
      slot: result.slot,
    };
  }

  /**
   * Update Account Delivery Preference (PLAN-0018 Section 2.2)
   */
  async updateDeliveryPreference(
    promoterId: string,
    websiteId: string,
    preference: 'high' | 'medium' | 'low',
  ) {
    const [updated] = await this.db
      .update(adsPromoterWebsites)
      .set({
        deliveryPreference: preference,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(adsPromoterWebsites.id, websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
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
        .where(
          and(
            eq(adstationDirectCampaigns.promoterId, promoterId),
            eq(adstationDirectCampaigns.websiteId, websiteId),
          ),
        )
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
    return this.db.transaction(async tx=>{
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);

    const [website] = await tx
      .select()
      .from(adsPromoterWebsites)
      .where(
        and(
          eq(adsPromoterWebsites.id, dto.websiteId),
          eq(adsPromoterWebsites.promoterId, promoterId),
        ),
      )
      .for('share').limit(1);

    if (!website) {
      throw new NotFoundException('Promoter website not found or unauthorized');
    }

    if (dto.slotId) {
      const [slot] = await tx
        .select()
        .from(adstationSlots)
        .where(
          and(
            eq(adstationSlots.id, dto.slotId),
            eq(adstationSlots.promoterId, promoterId),
            eq(adstationSlots.websiteId, dto.websiteId),
          ),
        )
        .for('share').limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found or unauthorized');
      }

      if (slot.retiredAt) throw new ForbiddenException('Retired slots cannot accept direct deals.');

      if (slot.isConsiderationSlot || slot.slotType === 'consideration') {
        throw new BadRequestException(
          'Direct deals cannot be assigned to a Consideration Slot. Consideration slots serve exclusively CrimFig network ads.',
        );
      }
    }

    const [campaign] = await tx
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
    });
  }

  async submitDirectSlotForReview(promoterId: string, slotId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);

      const [slot] = await tx
        .select()
        .from(adstationSlots)
        .where(
          and(
            eq(adstationSlots.id, slotId),
            eq(adstationSlots.promoterId, promoterId),
          ),
        )
        .for('update')
        .limit(1);

      if (!slot) {
        throw new NotFoundException('AdStation slot not found or unauthorized');
      }

      if (slot.slotType !== 'direct') {
        throw new BadRequestException('Only Direct Ad Slots use AdStation direct review submission.');
      }

      if(slot.retiredAt)throw new ForbiddenException('Retired slots cannot be submitted for review.');

      if (slot.lifecycleStatus === 'suspended') {
        throw new ForbiddenException('Suspended slots cannot be submitted for review.');
      }

      const [website] = await tx
        .select()
        .from(adsPromoterWebsites)
        .where(eq(adsPromoterWebsites.id, slot.websiteId))
        .for('share')
        .limit(1);
      const websiteSlots = await tx
        .select()
        .from(adstationSlots)
        .where(eq(adstationSlots.websiteId, slot.websiteId));

      const nextLifecycle = slot.lifecycleStatus === 'draft' ? 'testing' : slot.lifecycleStatus;
      const [updated] = await tx
        .update(adstationSlots)
        .set({
          lifecycleStatus: nextLifecycle,
          manualReviewStatus: 'pending_review',
          approvedRevision: null,
          reviewReason: null,
          isActive: nextLifecycle !== 'paused' && nextLifecycle !== 'disabled',
          updatedAt: new Date(),
        })
        .where(eq(adstationSlots.id, slotId))
        .returning();

      return {
        ...updated,
        adstationReadiness: evaluateDirectSlotReadiness(updated, website, websiteSlots),
      };
    });
  }

  /**
   * Record Direct Deal Ad Event with Idempotency Deduplication (PLAN-0018 Phase 3)
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

    if (dto.slotId) {
      const [slot] = await this.db
        .select()
        .from(adstationSlots)
        .where(
          and(
            eq(adstationSlots.id, dto.slotId),
            eq(adstationSlots.websiteId, dto.websiteId),
          ),
        )
        .limit(1);
      if (!slot) {
        throw new NotFoundException('AdStation slot not found for website');
      }
      if (slot.slotType === 'direct') {
        const [website] = await this.db
          .select()
          .from(adsPromoterWebsites)
          .where(eq(adsPromoterWebsites.id, dto.websiteId))
          .limit(1);
        const websiteSlots = await this.db
          .select()
          .from(adstationSlots)
          .where(eq(adstationSlots.websiteId, dto.websiteId));
        const readiness = evaluateDirectSlotReadiness(slot, website, websiteSlots);
        if (slot.lifecycleStatus !== 'active' || !readiness.liveEligible) {
          throw new ForbiddenException(
            `Direct Ad Slot is not eligible for live delivery: ${readiness.blockerReasons.join(' ')}`,
          );
        }
      }
    }

    const input = {
      directCampaignId: dto.directCampaignId,
      websiteId: dto.websiteId,
      slotId: dto.slotId || null,
      eventType: dto.eventType,
      idempotencyKey: dto.idempotencyKey,
      isViewable: dto.isViewable ?? false,
      viewDurationMs: dto.viewDurationMs ?? 0,
      ipHash: dto.ipHash || null,
      userAgent: dto.userAgent || null,
    };

    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const [event] = await tx.insert(schema.adstationAdEvents).values(input)
        .onConflictDoNothing({ target: schema.adstationAdEvents.idempotencyKey })
        .returning();

      if (!event) {
        const [prior] = await tx.select().from(schema.adstationAdEvents)
          .where(eq(schema.adstationAdEvents.idempotencyKey, input.idempotencyKey));
        if (!prior || prior.directCampaignId !== input.directCampaignId.toLowerCase() ||
            prior.websiteId !== input.websiteId.toLowerCase() || prior.slotId !== (input.slotId?.toLowerCase() ?? null) ||
            prior.eventType !== input.eventType || prior.isViewable !== input.isViewable ||
            prior.viewDurationMs !== input.viewDurationMs) {
          throw new ConflictException('Direct event identity changed');
        }
        return { status: 'duplicate_ignored', eventId: prior.id };
      }

      const impression = event.eventType === 'impression' || event.eventType === 'viewable_impression';
      if (impression || event.eventType === 'click') {
        await tx.update(adstationDirectCampaigns).set({
          ...(impression
            ? { deliveredImpressions: sql`${adstationDirectCampaigns.deliveredImpressions} + 1` }
            : { deliveredClicks: sql`${adstationDirectCampaigns.deliveredClicks} + 1` }),
          updatedAt: new Date(),
        }).where(eq(adstationDirectCampaigns.id, event.directCampaignId));
      }

      return { status: 'recorded', eventId: event.id };
    }, { isolationLevel: 'read committed' });
  }

  /**
   * Consideration Slot 48-Hour Grace State Machine (PLAN-0018 Phase 6)
   */
  async checkConsiderationSlotHealth(websiteId: string, promoterId?: string) {
    const [website] = await this.db
      .select()
      .from(adsPromoterWebsites)
      .where(
        promoterId
          ? and(
              eq(adsPromoterWebsites.id, websiteId),
              eq(adsPromoterWebsites.promoterId, promoterId),
            )
          : eq(adsPromoterWebsites.id, websiteId),
      )
      .limit(1);

    if (!website) {
      throw new NotFoundException('Website not found');
    }

    const considerationSlots = await this.db
      .select()
      .from(adstationSlots)
      .where(
        and(
          eq(adstationSlots.websiteId, websiteId),
          eq(adstationSlots.isConsiderationSlot, true),
          eq(adstationSlots.isActive, true),
        ),
      );

    const hasHealthyConsideration = considerationSlots.some(
      (s) => s.isConsiderationVerified,
    );

    if (hasHealthyConsideration) {
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
      return {
        status: 'healthy',
        considerationVerified: true,
        graceActive: false,
      };
    }

    const referenceTime =
      website.considerationSlotVerifiedAt ||
      website.lastVerificationAttemptAt ||
      website.createdAt;
    const gracePeriodMs = 48 * 60 * 60 * 1000;
    const elapsedMs = Date.now() - new Date(referenceTime).getTime();
    const graceRemainingHours = Math.max(
      0,
      Math.round((gracePeriodMs - elapsedMs) / (60 * 60 * 1000)),
    );

    if (elapsedMs > gracePeriodMs) {
      await this.db
        .update(adsPromoterWebsites)
        .set({
          considerationSlotActive: false,
          isSuspended: true,
          policyStatus: 'suspended',
          suspensionReason:
            'Consideration slot requirement unfulfilled past 48-hour grace window.',
          updatedAt: new Date(),
        })
        .where(eq(adsPromoterWebsites.id, websiteId));

      return {
        status: 'suspended',
        considerationVerified: false,
        graceActive: false,
        graceRemainingHours: 0,
        reason:
          'Consideration slot requirement unfulfilled past 48-hour grace window.',
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

}
