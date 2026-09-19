import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsPlacements,
  adsCampaigns,
  adsCreatives,
  adsPromoters,
  adsPromoterWebsites,
  adsPromoterApps,
} from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import * as crypto from 'crypto';

@Injectable()
export class PlacementsService {
  private readonly logger = new Logger(PlacementsService.name);
  private readonly hmacSecret = process.env.HMAC_SECRET || 'crimfig-ads-hmac-secret-key-2026';

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Create an ad placement for a promoter
   */
  async createPlacement(params: {
    promoterId: string;
    campaignId: string;
    creativeId?: string;
    websiteId?: string;
    appId?: string;
  }) {
    // 1. Verify active campaign
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, params.campaignId), eq(adsCampaigns.status, 'active')))
      .limit(1);

    if (!campaign) {
      throw new BadRequestException('Campaign not found or not currently active');
    }

    // 2. Select or verify creative
    let creativeId = params.creativeId;
    if (!creativeId) {
      const [firstCreative] = await this.db
        .select()
        .from(adsCreatives)
        .where(and(eq(adsCreatives.campaignId, params.campaignId), eq(adsCreatives.status, 'active')))
        .limit(1);

      if (!firstCreative) {
        throw new BadRequestException('This campaign has no active creatives');
      }
      creativeId = firstCreative.id;
    }

    // 3. Generate secure placement token and HMAC signature
    const placementToken = crypto.randomBytes(32).toString('hex');
    const linkSignature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(`${placementToken}:${params.promoterId}:${params.campaignId}`)
      .digest('hex');

    // 4. Save placement
    const [placement] = await this.db
      .insert(adsPlacements)
      .values({
        promoterId: params.promoterId,
        campaignId: params.campaignId,
        creativeId,
        websiteId: params.websiteId || null,
        appId: params.appId || null,
        placementToken,
        linkSignature,
        status: 'active',
      })
      .returning();

    // 5. Generate channel integration code
    const baseUrl = process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com';
    const embedSnippet = `<div id="cf-ad-${placementToken}" class="crimfig-ad-slot"></div>\n<script src="${baseUrl}/api/v1/delivery/embed.js" data-placement="${placementToken}" async></script>`;
    const shareLink = `${baseUrl}/api/v1/delivery/go/${placementToken}?pid=${params.promoterId}`;

    return {
      ...placement,
      embedSnippet,
      shareLink,
      campaignTitle: campaign.title,
    };
  }

  /**
   * Get all placements for a promoter
   */
  async getPromoterPlacements(promoterId: string) {
    const placements = await this.db
      .select({
        id: adsPlacements.id,
        placementToken: adsPlacements.placementToken,
        status: adsPlacements.status,
        createdAt: adsPlacements.createdAt,
        websiteId: adsPlacements.websiteId,
        appId: adsPlacements.appId,
        campaign: {
          id: adsCampaigns.id,
          title: adsCampaigns.title,
          format: adsCampaigns.format,
          costPerClickUsdCents: adsCampaigns.costPerClickUsdCents,
          costPerImpressionUsdCents: adsCampaigns.costPerImpressionUsdCents,
        },
        creative: {
          id: adsCreatives.id,
          headline: adsCreatives.headline,
          ctaText: adsCreatives.ctaText,
          imageUrl: adsCreatives.imageUrl,
          destinationUrl: adsCreatives.destinationUrl,
        },
      })
      .from(adsPlacements)
      .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
      .innerJoin(adsCreatives, eq(adsPlacements.creativeId, adsCreatives.id))
      .where(eq(adsPlacements.promoterId, promoterId))
      .orderBy(desc(adsPlacements.createdAt));

    const baseUrl = process.env.ADS_PUBLIC_URL || 'https://ads.crimfig.com';

    return placements.map((p) => ({
      ...p,
      embedSnippet: `<div id="cf-ad-${p.placementToken}" class="crimfig-ad-slot"></div>\n<script src="${baseUrl}/api/v1/delivery/embed.js" data-placement="${p.placementToken}" async></script>`,
      shareLink: `${baseUrl}/api/v1/delivery/go/${p.placementToken}?pid=${promoterId}`,
    }));
  }
}
