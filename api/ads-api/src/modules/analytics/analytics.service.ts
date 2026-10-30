import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsInteractions,
  adsPromoterEarnings,
  adsPlacements,
  adsCampaigns,
  adsCreatives,
  adsMetricsHourly,
  adsUserTablePreferences,
} from '@crimfig/database/schema';
import { eq, sql, desc, and, gte, lte } from 'drizzle-orm';

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Performance and earnings analytics for a promoter.
   * Separates validated paid events (`isValid = true`) from filtered invalid / house / shadow events (`PLAN-0047`).
   */
  async getPromoterAnalytics(promoterId: string) {
    // Validated impressions
    const [impressionsResult] = await this.db
      .select({
        count: sql<number>`count(*) filter (where ${adsInteractions.isValid} = true)`,
        grossCount: sql<number>`count(*)`,
      })
      .from(adsInteractions)
      .where(and(eq(adsInteractions.promoterId, promoterId), eq(adsInteractions.type, 'impression')));

    // Validated clicks
    const [clicksResult] = await this.db
      .select({
        count: sql<number>`count(*) filter (where ${adsInteractions.isValid} = true)`,
        grossCount: sql<number>`count(*)`,
      })
      .from(adsInteractions)
      .where(and(eq(adsInteractions.promoterId, promoterId), eq(adsInteractions.type, 'click')));

    // Total earnings (house/shadow serves produce zero rows in ads_promoter_earnings)
    const [earningsResult] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${adsPromoterEarnings.amountUsdCents}), 0)` })
      .from(adsPromoterEarnings)
      .where(eq(adsPromoterEarnings.promoterId, promoterId));

    const totalImpressions = Number(impressionsResult?.count ?? 0);
    const grossImpressions = Number((impressionsResult as any)?.grossCount ?? totalImpressions);
    const totalClicks = Number(clicksResult?.count ?? 0);
    const grossClicks = Number((clicksResult as any)?.grossCount ?? totalClicks);
    const totalEarningsCents = Number(earningsResult?.total || 0);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    // Recent activity log
    const recentLogs = await this.db
      .select({
        id: adsInteractions.id,
        type: adsInteractions.type,
        source: adsInteractions.source,
        referrer: adsInteractions.referrer,
        isValid: adsInteractions.isValid,
        assessmentStatus: adsInteractions.assessmentStatus,
        createdAt: adsInteractions.createdAt,
      })
      .from(adsInteractions)
      .where(eq(adsInteractions.promoterId, promoterId))
      .orderBy(desc(adsInteractions.createdAt))
      .limit(20);

    return {
      impressions: totalImpressions,
      grossImpressions,
      clicks: totalClicks,
      grossClicks,
      ctr: parseFloat(ctr.toFixed(2)),
      earningsUsd: totalEarningsCents / 100,
      recentActivity: recentLogs,
    };
  }

  /**
   * Analytics and spend tracking for an advertiser
   */
  async getAdvertiserAnalytics(advertiserId: string) {
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    const campaignIds = campaigns.map((c) => c.id);

    let totalImpressions = 0;
    let totalClicks = 0;
    let totalHovers = 0;
    let totalTouches = 0;

    if (campaignIds.length > 0) {
      const counts = await this.db
        .select({
          type: adsInteractions.type,
          count: sql<number>`count(*) filter (where ${adsInteractions.isValid} = true)`,
        })
        .from(adsInteractions)
        .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
        .where(
          and(
            sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`,
            eq(adsInteractions.isValid, true),
          ),
        )
        .groupBy(adsInteractions.type);

      for (const row of counts) {
        const c = Number(row.count || 0);
        if (row.type === 'impression') totalImpressions = c;
        else if (row.type === 'click') totalClicks = c;
        else if (row.type === 'hover') totalHovers = c;
        else if (row.type === 'touch') totalTouches = c;
      }
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
      hovers: totalHovers,
      touches: totalTouches,
      ctr: parseFloat(ctr.toFixed(2)),
    };
  }

  /**
   * Dashboard Summary Metrics with date range filtering (7d, 30d, 90d, custom)
   */
  async getDashboardSummary(advertiserId: string, period = '30d', startDateStr?: string, endDateStr?: string) {
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    const campaignIds = campaigns.map((c) => c.id);

    const activeCount = campaigns.filter((c) => c.status === 'active').length;
    const pausedCount = campaigns.filter((c) => c.status === 'paused').length;
    const reviewCount = campaigns.filter((c) => c.status === 'under_review').length;
    const draftCount = campaigns.filter((c) => c.status === 'draft').length;

    // Creatives status counts
    let rejectedCreativesCount = 0;
    let pendingCreativesCount = 0;

    if (campaignIds.length > 0) {
      const creatives = await this.db
        .select({
          status: adsCreatives.reviewStatus,
        })
        .from(adsCreatives)
        .where(sql`${adsCreatives.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`);

      rejectedCreativesCount = creatives.filter((c) => c.status === 'rejected').length;
      pendingCreativesCount = creatives.filter((c) => c.status === 'pending').length;
    }

    // Determine time boundary
    const now = new Date();
    let startDate = new Date();
    if (period === '7d') startDate.setDate(now.getDate() - 7);
    else if (period === '90d') startDate.setDate(now.getDate() - 90);
    else if (period === 'custom' && startDateStr) startDate = new Date(startDateStr);
    else startDate.setDate(now.getDate() - 30); // 30d default

    let totalImpressions = 0;
    let totalClicks = 0;
    let totalHovers = 0;
    let totalTouches = 0;

    if (campaignIds.length > 0) {
      const interactionCounts = await this.db
        .select({
          type: adsInteractions.type,
          count: sql<number>`count(*) filter (where ${adsInteractions.isValid} = true)`,
        })
        .from(adsInteractions)
        .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
        .where(
          and(
            sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`,
            eq(adsInteractions.isValid, true),
            gte(adsInteractions.createdAt, startDate),
          ),
        )
        .groupBy(adsInteractions.type);

      for (const row of interactionCounts) {
        const c = Number(row.count || 0);
        if (row.type === 'impression') totalImpressions = c;
        else if (row.type === 'click') totalClicks = c;
        else if (row.type === 'hover') totalHovers = c;
        else if (row.type === 'touch') totalTouches = c;
      }
    }

    const totalBudgetCents = campaigns.reduce((acc, c) => acc + (Number(c.budgetUsdCents) || 0), 0);
    const totalRemainingCents = campaigns.reduce((acc, c) => acc + (Number(c.remainingBudgetUsdCents) || 0), 0);
    const totalSpentCents = Math.max(0, totalBudgetCents - totalRemainingCents);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const avgCpmUsd = totalImpressions > 0 ? ((totalSpentCents / 100) / totalImpressions) * 1000 : 0;
    const avgCpcUsd = totalClicks > 0 ? (totalSpentCents / 100) / totalClicks : 0;

    return {
      period,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      campaignCounts: {
        total: campaigns.length,
        active: activeCount,
        paused: pausedCount,
        underReview: reviewCount,
        draft: draftCount,
      },
      creativeAlertCounts: {
        rejected: rejectedCreativesCount,
        pendingReview: pendingCreativesCount,
      },
      financials: {
        totalBudgetUsd: totalBudgetCents / 100,
        totalSpentUsd: totalSpentCents / 100,
        remainingBudgetUsd: totalRemainingCents / 100,
      },
      performance: {
        impressions: totalImpressions,
        clicks: totalClicks,
        hovers: totalHovers,
        touches: totalTouches,
        ctr: Number.isFinite(ctr) ? parseFloat(ctr.toFixed(2)) : 0,
        avgCpmUsd: Number.isFinite(avgCpmUsd) ? parseFloat(avgCpmUsd.toFixed(2)) : 0,
        avgCpcUsd: Number.isFinite(avgCpcUsd) ? parseFloat(avgCpcUsd.toFixed(2)) : 0,
      },
    };
  }

  /**
   * Timeseries Datapoints for Charts (impressions, clicks, hovers, spend)
   */
  async getDashboardTimeseries(advertiserId: string, period = '30d') {
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const now = new Date();
    const result: Array<{
      date: string;
      impressions: number;
      clicks: number;
      hovers: number;
      touches: number;
      spendUsd: number;
    }> = [];

    // Pre-populate daily slots
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      result.push({
        date: dateStr,
        impressions: 0,
        clicks: 0,
        hovers: 0,
        touches: 0,
        spendUsd: 0,
      });
    }

    const campaigns = await this.db
      .select({ id: adsCampaigns.id })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    if (campaigns.length === 0) {
      return result;
    }

    const campaignIds = campaigns.map((c) => c.id);
    const startDate = new Date();
    startDate.setDate(now.getDate() - days);

    // Group interactions by day & type
    const dailyInteractions = await this.db
      .select({
        day: sql<string>`TO_CHAR(${adsInteractions.createdAt}, 'YYYY-MM-DD')`,
        type: adsInteractions.type,
        count: sql<number>`count(*)`,
      })
      .from(adsInteractions)
      .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
      .where(
        and(
          sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`,
          gte(adsInteractions.createdAt, startDate),
        ),
      )
      .groupBy(sql`TO_CHAR(${adsInteractions.createdAt}, 'YYYY-MM-DD')`, adsInteractions.type);

    const lookupMap = new Map<string, { impressions: number; clicks: number; hovers: number; touches: number; spend: number }>();
    for (const row of dailyInteractions) {
      if (!lookupMap.has(row.day)) {
        lookupMap.set(row.day, { impressions: 0, clicks: 0, hovers: 0, touches: 0, spend: 0 });
      }
      const item = lookupMap.get(row.day)!;
      const count = Number(row.count || 0);
      if (row.type === 'impression') {
        item.impressions += count;
        item.spend += (count * 1) / 100; // $0.01 per impression estimate
      } else if (row.type === 'click') {
        item.clicks += count;
        item.spend += (count * 10) / 100; // $0.10 per click estimate
      } else if (row.type === 'hover') {
        item.hovers += count;
      } else if (row.type === 'touch') {
        item.touches += count;
      }
    }

    return result.map((r) => {
      const data = lookupMap.get(r.date);
      if (data) {
        return {
          date: r.date,
          impressions: data.impressions,
          clicks: data.clicks,
          hovers: data.hovers,
          touches: data.touches,
          spendUsd: parseFloat(data.spend.toFixed(2)),
        };
      }
      return r;
    });
  }

  /**
   * Channel Distribution Breakdown (Websites, Mobile Apps, Social Reels)
   */
  async getDashboardChannelBreakdown(advertiserId: string, period = '30d') {
    const campaigns = await this.db
      .select({ id: adsCampaigns.id })
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    if (campaigns.length === 0) {
      return [
        { channel: 'Websites', impressions: 0, clicks: 0, percentage: 0 },
        { channel: 'Mobile Apps', impressions: 0, clicks: 0, percentage: 0 },
        { channel: 'Reels & Social Links', impressions: 0, clicks: 0, percentage: 0 },
      ];
    }

    const campaignIds = campaigns.map((c) => c.id);

    const sourceStats = await this.db
      .select({
        source: adsInteractions.source,
        type: adsInteractions.type,
        count: sql<number>`count(*)`,
      })
      .from(adsInteractions)
      .innerJoin(adsPlacements, eq(adsInteractions.placementId, adsPlacements.id))
      .where(sql`${adsPlacements.campaignId} IN (${sql.join(campaignIds.map((id) => sql`${id}`), sql`, `)})`)
      .groupBy(adsInteractions.source, adsInteractions.type);

    let webImp = 0;
    let webClk = 0;
    let appImp = 0;
    let appClk = 0;
    let socialImp = 0;
    let socialClk = 0;

    for (const row of sourceStats) {
      const c = Number(row.count || 0);
      if (row.source === 'embed_website' || row.source === 'embed') {
        if (row.type === 'impression') webImp += c;
        else if (row.type === 'click') webClk += c;
      } else if (row.source === 'mobile_sdk' || row.source === 'app') {
        if (row.type === 'impression') appImp += c;
        else if (row.type === 'click') appClk += c;
      } else {
        if (row.type === 'impression') socialImp += c;
        else if (row.type === 'click') socialClk += c;
      }
    }

    const totalImp = webImp + appImp + socialImp;
    return [
      {
        channel: 'Websites',
        impressions: webImp,
        clicks: webClk,
        percentage: totalImp > 0 ? parseFloat(((webImp / totalImp) * 100).toFixed(1)) : 33.3,
      },
      {
        channel: 'Mobile Apps',
        impressions: appImp,
        clicks: appClk,
        percentage: totalImp > 0 ? parseFloat(((appImp / totalImp) * 100).toFixed(1)) : 33.3,
      },
      {
        channel: 'Reels & Social Links',
        impressions: socialImp,
        clicks: socialClk,
        percentage: totalImp > 0 ? parseFloat(((socialImp / totalImp) * 100).toFixed(1)) : 33.4,
      },
    ];
  }

  /**
   * Actionable Alerts for Dashboard
   */
  async getDashboardAlerts(advertiserId: string) {
    const alerts: Array<{
      id: string;
      type: 'warning' | 'error' | 'info';
      title: string;
      message: string;
      severity: 'high' | 'medium' | 'low';
      actionLabel?: string;
      actionUrl?: string;
    }> = [];

    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    for (const c of campaigns) {
      const budget = Number(c.budgetUsdCents) || 0;
      const remaining = Number(c.remainingBudgetUsdCents) || 0;

      // Low balance alert (< 10% remaining)
      if (c.status === 'active' && budget > 0 && remaining <= budget * 0.1) {
        alerts.push({
          id: `low_balance_${c.id}`,
          type: 'warning',
          title: `Low Campaign Budget: ${c.title}`,
          message: `Only $${(remaining / 100).toFixed(2)} remaining of $${(budget / 100).toFixed(2)} total budget. Consider increasing budget to prevent pause.`,
          severity: 'high',
          actionLabel: 'Manage Budget',
          actionUrl: `/ads/campaigns/${c.id}`,
        });
      }

      // Check rejected creatives for inline replacement
      const rejectedCreatives = await this.db
        .select()
        .from(adsCreatives)
        .where(
          and(
            eq(adsCreatives.campaignId, c.id),
            eq(adsCreatives.reviewStatus, 'rejected'),
          ),
        );

      for (const cr of rejectedCreatives) {
        alerts.push({
          id: `rejected_creative_${cr.id}`,
          type: 'error',
          title: `Creative Asset Rejected: "${cr.headline || 'Untitled Asset'}"`,
          message: cr.rejectionReason || 'Asset flagged by moderation policy. Inline replacement required before ad can run.',
          severity: 'high',
          actionLabel: 'Replace Asset',
          actionUrl: `/ads/campaigns/${c.id}?replaceCreative=${cr.id}`,
        });
      }
    }

    return alerts;
  }

  /**
   * Get user customizable table preferences (columns, ordering, visibility)
   */
  async getUserTablePreferences(userId: string, tableName = 'campaigns_performance') {
    const [existing] = await this.db
      .select()
      .from(adsUserTablePreferences)
      .where(
        and(
          eq(adsUserTablePreferences.userId, userId),
          eq(adsUserTablePreferences.tableName, tableName),
        ),
      )
      .limit(1);

    if (existing) {
      try {
        return JSON.parse(existing.columnsConfig);
      } catch {
        // fallback
      }
    }

    // Default configuration
    return [
      { key: 'campaign', label: 'Campaign Title', visible: true, order: 0 },
      { key: 'status', label: 'Status', visible: true, order: 1 },
      { key: 'budget', label: 'Total Budget', visible: true, order: 2 },
      { key: 'spend', label: 'Spend', visible: true, order: 3 },
      { key: 'views', label: 'Views (Impressions)', visible: true, order: 4 },
      { key: 'clicks', label: 'Clicks', visible: true, order: 5 },
      { key: 'hovers', label: 'Hovers', visible: true, order: 6 },
      { key: 'touches', label: 'Touches', visible: true, order: 7 },
      { key: 'ctr', label: 'CTR (%)', visible: true, order: 8 },
      { key: 'actions', label: 'Actions', visible: true, order: 9 },
    ];
  }

  /**
   * Save user customizable table preferences
   */
  async saveUserTablePreferences(userId: string, tableName = 'campaigns_performance', columnsConfig: any) {
    const [existing] = await this.db
      .select()
      .from(adsUserTablePreferences)
      .where(
        and(
          eq(adsUserTablePreferences.userId, userId),
          eq(adsUserTablePreferences.tableName, tableName),
        ),
      )
      .limit(1);

    const serialized = JSON.stringify(columnsConfig);

    if (existing) {
      const [updated] = await this.db
        .update(adsUserTablePreferences)
        .set({
          columnsConfig: serialized,
          updatedAt: new Date(),
        })
        .where(eq(adsUserTablePreferences.id, existing.id))
        .returning();

      return JSON.parse(updated.columnsConfig);
    }

    const [created] = await this.db
      .insert(adsUserTablePreferences)
      .values({
        userId,
        tableName,
        columnsConfig: serialized,
      })
      .returning();

    return JSON.parse(created.columnsConfig);
  }
}
