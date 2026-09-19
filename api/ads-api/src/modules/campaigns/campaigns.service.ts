import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsCampaigns, adsCreatives } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Create a new advertising campaign
   */
  async createCampaign(params: {
    advertiserId: string;
    title: string;
    description?: string;
    budgetUsd: number;
    costPerImpressionCents?: number;
    costPerClickCents?: number;
    format?: 'banner' | 'card' | 'video' | 'interstitial';
    targeting?: any;
    startsAt?: Date;
    endsAt?: Date;
  }) {
    if (params.budgetUsd < 5) {
      throw new BadRequestException('Minimum campaign budget is $5.00 USD');
    }

    const budgetCents = Math.round(params.budgetUsd * 100);

    const [campaign] = await this.db
      .insert(adsCampaigns)
      .values({
        advertiserId: params.advertiserId,
        title: params.title,
        description: params.description,
        budgetUsdCents: budgetCents,
        remainingBudgetUsdCents: budgetCents,
        costPerImpressionUsdCents: params.costPerImpressionCents || 1, // $0.01
        costPerClickUsdCents: params.costPerClickCents || 10,         // $0.10
        format: params.format || 'card',
        status: 'active',
        targeting: params.targeting ? JSON.stringify(params.targeting) : null,
        startsAt: params.startsAt || new Date(),
        endsAt: params.endsAt,
      })
      .returning();

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
        status: 'active',
      })
      .returning();

    return creative;
  }

  /**
   * Get all campaigns created by an advertiser
   */
  async getAdvertiserCampaigns(advertiserId: string) {
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId))
      .orderBy(desc(adsCampaigns.createdAt));

    return campaigns.map((c) => ({
      ...c,
      budgetUsd: c.budgetUsdCents / 100,
      remainingBudgetUsd: c.remainingBudgetUsdCents / 100,
      spentUsd: (c.budgetUsdCents - c.remainingBudgetUsdCents) / 100,
    }));
  }

  /**
   * Get single campaign details including creatives
   */
  async getCampaignDetails(campaignId: string, advertiserId?: string) {
    const conditions = [eq(adsCampaigns.id, campaignId)];
    if (advertiserId) {
      conditions.push(eq(adsCampaigns.advertiserId, advertiserId));
    }

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
      remainingBudgetUsd: campaign.remainingBudgetUsdCents / 100,
      spentUsd: (campaign.budgetUsdCents - campaign.remainingBudgetUsdCents) / 100,
      creatives,
    };
  }

  /**
   * Get active campaigns for promoters to browse and apply
   */
  async getPublicCatalog() {
    const activeCampaigns = await this.db
      .select({
        id: adsCampaigns.id,
        title: adsCampaigns.title,
        description: adsCampaigns.description,
        format: adsCampaigns.format,
        costPerImpressionUsdCents: adsCampaigns.costPerImpressionUsdCents,
        costPerClickUsdCents: adsCampaigns.costPerClickUsdCents,
        remainingBudgetUsdCents: adsCampaigns.remainingBudgetUsdCents,
        createdAt: adsCampaigns.createdAt,
      })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.status, 'active'))
      .orderBy(desc(adsCampaigns.createdAt));

    return activeCampaigns.map((c) => ({
      ...c,
      costPerClickUsd: c.costPerClickUsdCents / 100,
      costPerImpressionUsd: c.costPerImpressionUsdCents / 100,
    }));
  }

  /**
   * Update campaign status (pause, resume, cancel)
   */
  async updateStatus(campaignId: string, advertiserId: string, status: 'active' | 'paused' | 'cancelled') {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, advertiserId)))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    const [updated] = await this.db
      .update(adsCampaigns)
      .set({ status, updatedAt: new Date() })
      .where(eq(adsCampaigns.id, campaignId))
      .returning();

    return updated;
  }
}
