import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsInteractions,
  adsPromoterEarnings,
  adsPlacements,
  adsCampaigns,
} from '@crimfig/database/schema';
import { eq, sql, desc, and } from 'drizzle-orm';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Performance and earnings analytics for a promoter
   */
  async getPromoterAnalytics(promoterId: string) {
    // Total impressions
    const [impressionsResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(adsInteractions)
      .where(and(eq(adsInteractions.promoterId, promoterId), eq(adsInteractions.type, 'impression')));

    // Total clicks
    const [clicksResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(adsInteractions)
      .where(and(eq(adsInteractions.promoterId, promoterId), eq(adsInteractions.type, 'click')));

    // Total earnings
    const [earningsResult] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${adsPromoterEarnings.amountUsdCents}), 0)` })
      .from(adsPromoterEarnings)
      .where(eq(adsPromoterEarnings.promoterId, promoterId));

    const totalImpressions = Number(impressionsResult?.count || 0);
    const totalClicks = Number(clicksResult?.count || 0);
    const totalEarningsCents = Number(earningsResult?.total || 0);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    // Recent activity log
    const recentLogs = await this.db
      .select({
        id: adsInteractions.id,
        type: adsInteractions.type,
        source: adsInteractions.source,
        referrer: adsInteractions.referrer,
        createdAt: adsInteractions.createdAt,
      })
      .from(adsInteractions)
      .where(eq(adsInteractions.promoterId, promoterId))
      .orderBy(desc(adsInteractions.createdAt))
      .limit(20);

    return {
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr: parseFloat(ctr.toFixed(2)),
      earningsUsd: totalEarningsCents / 100,
      recentActivity: recentLogs,
    };
  }

  /**
   * Analytics and spend tracking for an advertiser
   */
  async getAdvertiserAnalytics(advertiserId: string) {
    // Get all campaigns for advertiser
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    const campaignIds = campaigns.map((c) => c.id);

    let totalImpressions = 0;
    let totalClicks = 0;

    if (campaignIds.length > 0) {
      const [impResult] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(adsInteractions)
        .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
        .where(
          and(
            sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`,
            eq(adsInteractions.type, 'impression'),
          ),
        );

      const [clkResult] = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(adsInteractions)
        .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
        .where(
          and(
            sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`,
            eq(adsInteractions.type, 'click'),
          ),
        );

      totalImpressions = Number(impResult?.count || 0);
      totalClicks = Number(clkResult?.count || 0);
    }

    const totalBudgetCents = campaigns.reduce((acc, c) => acc + c.budgetUsdCents, 0);
    const totalRemainingCents = campaigns.reduce((acc, c) => acc + c.remainingBudgetUsdCents, 0);
    const totalSpentCents = totalBudgetCents - totalRemainingCents;
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    return {
      totalCampaigns: campaigns.length,
      totalBudgetUsd: totalBudgetCents / 100,
      totalSpentUsd: totalSpentCents / 100,
      remainingBudgetUsd: totalRemainingCents / 100,
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr: parseFloat(ctr.toFixed(2)),
    };
  }
}
