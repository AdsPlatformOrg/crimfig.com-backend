import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsCampaigns, adsCreatives } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import { AdsEscrowService } from '../billing/ads-escrow.service';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly escrowService: AdsEscrowService,
  ) {}

  /**
   * Create a new advertising campaign and lock allocated budget in escrow
   */
  async createCampaign(params: {
    advertiserId: string;
    title: string;
    description?: string;
    budgetUsd: number;
    dailyBudgetUsd?: number;
    costPerImpressionCents?: number;
    costPerClickCents?: number;
    pricingModel?: 'cpm' | 'cpc';
    format?: 'banner' | 'card' | 'video' | 'interstitial';
    targetCountries?: string[];
    targetStates?: string[];
    targetDevices?: string[];
    targetHours?: number[];
    frequencyCapPerDay?: number;
    targeting?: any;
    startsAt?: Date;
    endsAt?: Date;
  }) {
    if (params.budgetUsd < 5) {
      throw new BadRequestException('Minimum campaign budget is $5.00 USD');
    }

    for (const bid of [params.costPerImpressionCents ?? 1, params.costPerClickCents ?? 10]) {
      if (!Number.isSafeInteger(bid) || bid < 1 || bid > 2147483647) throw new BadRequestException('Bids require integer cents from 1 to 2147483647');
    }
    const budgetCents = Math.round(params.budgetUsd * 100);
    const dailyBudgetCents = params.dailyBudgetUsd ? Math.round(params.dailyBudgetUsd * 100) : null;
    const hourlyPacingCents = dailyBudgetCents ? Math.ceil(dailyBudgetCents / 24) : null;

    const [campaign] = await this.db
      .insert(adsCampaigns)
      .values({
        advertiserId: params.advertiserId,
        title: params.title,
        description: params.description,
        budgetUsdCents: budgetCents,
        dailyBudgetUsdCents: dailyBudgetCents,
        hourlyPacingUsdCents: hourlyPacingCents,
        remainingBudgetUsdCents: budgetCents,
        pricingVersion: 2,
        pricingModel: params.pricingModel || 'cpm',
        costPerImpressionUsdCents: params.costPerImpressionCents ?? 1, // $0.01 per 1,000 eligible impressions
        costPerClickUsdCents: params.costPerClickCents ?? 10,         // $0.10
        format: params.format || 'card',
        status: 'paused',
        moderationStatus: 'pending_primary_review',
        targetCountries: params.targetCountries ? JSON.stringify(params.targetCountries) : null,
        targetStates: params.targetStates ? JSON.stringify(params.targetStates) : null,
        targetDevices: params.targetDevices ? JSON.stringify(params.targetDevices) : null,
        targetHours: params.targetHours ? JSON.stringify(params.targetHours) : null,
        frequencyCapPerDay: params.frequencyCapPerDay || 5,
        targeting: params.targeting ? JSON.stringify(params.targeting) : null,
        startsAt: params.startsAt || new Date(),
        endsAt: params.endsAt,
      })
      .returning();

    // Attempt to lock budget in escrow immediately
    try {
      await this.escrowService.lockCampaignBudget({
        campaignId: campaign.id,
        userId: params.advertiserId,
        amountUsdCents: budgetCents,
        campaignTitle: params.title,
      });
    } catch (err: any) {
      this.logger.warn(`Campaign ${campaign.id} created as draft; escrow lock deferred: ${err.message}`);
    }

    return campaign;
  }

  /**
   * Add a creative asset to a campaign
   */
  async addCreative(params: {
    campaignId: string;
    advertiserId: string;
    headline: string;
    bodyText?: string;
    ctaText?: string;
    destinationUrl: string;
    imageUrl?: string;
    videoUrl?: string;
    adFormat?: 'banner' | 'card' | 'video' | 'interstitial';
    mediaFormat?: 'image' | 'gif' | 'video';
  }) {
    // Verify campaign ownership
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, params.campaignId), eq(adsCampaigns.advertiserId, params.advertiserId)))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found or unauthorized');
    }

    const [creative] = await this.db
      .insert(adsCreatives)
      .values({
        campaignId: params.campaignId,
        headline: params.headline,
        bodyText: params.bodyText,
        ctaText: params.ctaText || 'Learn More',
        destinationUrl: params.destinationUrl,
        imageUrl: params.imageUrl,
        videoUrl: params.videoUrl,
        adFormat: params.adFormat || campaign.format || 'card',
        mediaFormat: params.mediaFormat || 'image',
        reviewStatus: 'pending',
        status: 'active',
      })
      .returning();

    return creative;
  }

  /**
   * Replace / update a rejected creative asset with new media and re-submit for review
   */
  async replaceCreative(params: {
    creativeId: string;
    advertiserId: string;
    headline?: string;
    bodyText?: string;
    ctaText?: string;
    destinationUrl?: string;
    imageUrl?: string;
    videoUrl?: string;
    adFormat?: 'banner' | 'card' | 'video' | 'interstitial';
    mediaFormat?: 'image' | 'gif' | 'video';
  }) {
    // Verify ownership through joined campaign
    const [existing] = await this.db
      .select({
        creative: adsCreatives,
        campaign: adsCampaigns,
      })
      .from(adsCreatives)
      .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
      .where(
        and(
          eq(adsCreatives.id, params.creativeId),
          eq(adsCampaigns.advertiserId, params.advertiserId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new NotFoundException('Creative asset not found or unauthorized');
    }

    const updateFields: Partial<typeof adsCreatives.$inferInsert> = {
      reviewStatus: 'pending',
      rejectionReason: null,
      reviewedAt: null,
      updatedAt: new Date(),
    };

    if (params.headline) updateFields.headline = params.headline;
    if (params.bodyText !== undefined) updateFields.bodyText = params.bodyText;
    if (params.ctaText) updateFields.ctaText = params.ctaText;
    if (params.destinationUrl) updateFields.destinationUrl = params.destinationUrl;
    if (params.imageUrl !== undefined) updateFields.imageUrl = params.imageUrl;
    if (params.videoUrl !== undefined) updateFields.videoUrl = params.videoUrl;
    if (params.adFormat) updateFields.adFormat = params.adFormat;
    if (params.mediaFormat) updateFields.mediaFormat = params.mediaFormat;

    const [updated] = await this.db
      .update(adsCreatives)
      .set(updateFields)
      .where(eq(adsCreatives.id, params.creativeId))
      .returning();

    return updated;
  }

  /**
   * Submit a draft campaign for compliance review
   */
  async submitForReview(campaignId: string, advertiserId: string) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found or unauthorized');
    }

    // Enforce that campaign has budget escrow locked before submitting for review
    const escrow = await this.escrowService.getCampaignEscrow(campaignId, advertiserId);
    if (!escrow || escrow.status !== 'active') {
      // Attempt lock now if not yet locked
      await this.escrowService.lockCampaignBudget({
        campaignId: campaign.id,
        userId: advertiserId,
        amountUsdCents: campaign.budgetUsdCents,
        campaignTitle: campaign.title,
      });
    }

    const [updated] = await this.db
      .update(adsCampaigns)
      .set({
        status: 'paused',
        moderationStatus: 'pending_primary_review',
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, campaignId))
      .returning();

    return updated;
  }

  /**
   * Get all campaigns created by an advertiser with optional status filtering
   */
  async getAdvertiserCampaigns(advertiserId: string, status?: string) {
    const conditions = [eq(adsCampaigns.advertiserId, advertiserId)];
    if (status && status !== 'all') {
      conditions.push(eq(adsCampaigns.status, status as any));
    }

    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(...conditions))
      .orderBy(desc(adsCampaigns.createdAt));

    return campaigns.map((c) => ({
      ...c,
      budgetUsd: c.budgetUsdCents / 100,
      dailyBudgetUsd: c.dailyBudgetUsdCents ? c.dailyBudgetUsdCents / 100 : null,
      remainingBudgetUsd: c.remainingBudgetUsdCents / 100,
      spentUsd: (c.budgetUsdCents - c.remainingBudgetUsdCents) / 100,
    }));
  }

  /**
   * Get single campaign details including creatives
   */
  async getCampaignDetails(campaignId: string, advertiserId: string) {
    if (!advertiserId) throw new NotFoundException('Campaign not found');
    const conditions = [eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)];

    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(...conditions))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    const creatives = await this.db
      .select()
      .from(adsCreatives)
      .where(eq(adsCreatives.campaignId, campaignId));

    return {
      ...campaign,
      budgetUsd: campaign.budgetUsdCents / 100,
      dailyBudgetUsd: campaign.dailyBudgetUsdCents ? campaign.dailyBudgetUsdCents / 100 : null,
      remainingBudgetUsd: campaign.remainingBudgetUsdCents / 100,
      spentUsd: (campaign.budgetUsdCents - campaign.remainingBudgetUsdCents) / 100,
      creatives,
    };
  }

  /**
   * Get active campaigns for promoters to browse and apply
   * STRICT SHIELDING: Strips advertiser budgets, balances, bids, and advertiser identities.
   * Promoters only see public descriptive metadata and format eligibility.
   */
  async getPublicCatalog(category?: string) {
    const activeCampaigns = await this.db
      .select({
        id: adsCampaigns.id,
        title: adsCampaigns.title,
        description: adsCampaigns.description,
        format: adsCampaigns.format,
        createdAt: adsCampaigns.createdAt,
      })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.status, 'active'))
      .orderBy(desc(adsCampaigns.createdAt));

    return activeCampaigns.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      format: c.format,
      createdAt: c.createdAt,
      eligibleForPlacement: true,
    }));
  }

  /**
   * Update campaign status and trigger escrow lifecycle transitions
   */
  async updateStatus(
    campaignId: string,
    advertiserId: string,
    status: 'active' | 'paused' | 'under_review' | 'draft' | 'rejected' | 'suspended' | 'trash',
  ) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (!['active', 'paused', 'trash'].includes(status)) {
      throw new BadRequestException('Use the review workflow for moderation states');
    }
    if (campaign.status === 'suspended') {
      throw new BadRequestException('A suspended campaign requires staff review');
    }
    if (status === 'active' && campaign.moderationStatus !== 'approved') {
      throw new BadRequestException('Campaign must have completed moderation before activation');
    }
    // Billing owns the status + wallet + escrow + receipt transaction, including retries.
    return this.escrowService.changeCampaignStatus(campaignId, advertiserId, status as 'active' | 'paused' | 'trash');
  }
}
