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
  async getDirectCampaigns(promoterId: string, websiteId: string) {
    return this.db
      .select()
      .from(adstationDirectCampaigns)
      .where(and(eq(adstationDirectCampaigns.promoterId, promoterId), eq(adstationDirectCampaigns.websiteId, websiteId)))
      .orderBy(desc(adstationDirectCampaigns.createdAt));
  }

  /**
   * Create Direct Campaign
   * Enforces: CANNOT bind direct campaign to a Consideration Slot! (PLAN-0018 Section 2.1)
   */
  async createDirectCampaign(promoterId: string, dto: CreateDirectCampaignDto) {
    if (dto.slotId) {
      const [slot] = await this.db
        .select()
        .from(adstationSlots)
        .where(eq(adstationSlots.id, dto.slotId))
        .limit(1);

      if (slot && (slot.isConsiderationSlot || slot.slotType === 'consideration')) {
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
}
