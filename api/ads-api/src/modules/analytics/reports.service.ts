import { createHash } from 'node:crypto';
import { billedClick, observedClickRows } from './observed-clicks';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { addReportMetrics, emptyReportMetrics, REPORT_ZONE, reportMetrics, reportRange, type ReportMetrics } from './report-range';

type ReportRow = { day: string; campaignId: string | null; creativeId: string | null; campaign: string | null; creative: string | null } & ReportMetrics;

const promoterMetrics = [
  'confirmed',
  'pending',
  'promoConfirmed',
  'promoPending',
  'adjustments',
  'billableImpressions',
  'promoImpressions',
  'billableClicks',
] as const;
const advertiserMetrics = [
  'spend',
  'cpmSpend',
  'cpcSpend',
  'bonusSpend',
  'posted',
  'credits',
  'billableImpressions',
  'bonusImpressions',
  'billableClicks',
  'impressions',
  'clicks',
  'validClicks',
  'billedClicks',
] as const;

function reportReference(owner: string, dimension: 'campaign' | 'ad', id: string | null) {
  if (id === null) return null;
  return createHash('sha256').update(JSON.stringify([owner, dimension, id])).digest('hex');
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  async daily(owner: string, role: 'advertiser' | 'promoter', from?: string, to?: string, compare = false) {
    const now = new Date();
    const range = reportRange(from, to, now);
    const first = compare ? range.previousFrom : range.from;
    const start = sql`(${first}::date::timestamp AT TIME ZONE ${REPORT_ZONE})`;
    const end = sql`LEAST((${range.until}::date::timestamp AT TIME ZONE ${REPORT_ZONE}), ${now.toISOString()}::timestamptz)`;
    const advertiser = role === 'advertiser';
    const visibleMetrics = advertiser ? advertiserMetrics : promoterMetrics;
    const serializeMetrics = (values: ReportMetrics) => Object.fromEntries(visibleMetrics.map(key => [key, values[key]]));
    const ownerFilter = advertiser ? sql`campaign.advertiser_id = ${owner}` : sql`publisher.user_id = ${owner}`;
    // Event-date expense and whole-cent ledger postings are separate columns. Cash spend and
    // non-withdrawable bonus-credit spend are reported strictly in separate columns (PLAN-0155 G09).
    const earned = sql`(receipt.amount_usd_cents::numeric * 10000000)`;
    const price = sql`claim.price_nanos::numeric`;
    const projections = reportMetrics.map(key => sql`COALESCE(SUM(${sql.identifier(key)}), 0)::text AS ${sql.identifier(key)}`);
    const results = await this.db.execute<ReportRow>(sql`
      WITH entries AS (
        SELECT i.created_at AS at, campaign.id AS campaign_id, s.creative_id,
          ${advertiser ? price : sql`0`} AS spend,
          ${advertiser ? sql`CASE WHEN i.type = 'viewable_impression' THEN ${price} ELSE 0 END` : sql`0`} AS "cpmSpend",
          ${advertiser ? sql`CASE WHEN i.type = 'click' THEN ${price} ELSE 0 END` : sql`0`} AS "cpcSpend",
          0::numeric AS "bonusSpend",
          0::numeric AS posted, 0::numeric AS credits,
          ${advertiser ? sql`0` : sql`CASE WHEN receipt.status = 'completed' THEN ${earned} ELSE 0 END`} AS confirmed,
          ${advertiser ? sql`0` : sql`CASE WHEN receipt.status = 'pending' AND item.clearance_status = 'pending' THEN ${earned} ELSE 0 END`} AS pending,
          0::numeric AS "promoConfirmed",
          0::numeric AS "promoPending",
          0::numeric AS adjustments,
          (i.type = 'viewable_impression')::int AS "billableImpressions",
          0::int AS "bonusImpressions",
          0::int AS "promoImpressions",
          (i.type = 'click')::int AS "billableClicks", 0 AS impressions, 0 AS clicks, 0 AS "validClicks", 0 AS "billedClicks"
        FROM ads_settlement_claims claim
        JOIN ads_settlement_batches batch ON batch.id = claim.batch_id AND batch.status = 'completed'
        JOIN ads_interactions i ON i.id = claim.interaction_id AND i.serve_id = claim.serve_id
        JOIN ads_serves s ON s.id = claim.serve_id AND s.inventory_class = 'paid' AND s.delivery_mode = 'normal'
        JOIN ads_campaigns campaign ON campaign.id = s.campaign_id
        JOIN ads_promoters publisher ON publisher.id = claim.promoter_id AND publisher.id = s.promoter_id
        LEFT JOIN ads_promoter_settlement_items item ON item.batch_id = batch.id
          AND item.promoter_id = publisher.id AND item.idempotency_key = 'ads-item:v3:' || i.id::text
        LEFT JOIN billing_transactions receipt ON receipt.id = item.billing_transaction_id
          AND receipt.user_id = publisher.user_id AND receipt.type = 'ads_earning' AND receipt.provider = 'internal'
        WHERE ${ownerFilter} AND i.created_at >= ${start} AND i.created_at < ${end}
          AND ((s.pricing_model = 'cpm' AND i.type = 'viewable_impression') OR (s.pricing_model = 'cpc' AND i.type = 'click'))
        UNION ALL
        SELECT i.created_at, campaign.id, s.creative_id,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, (i.type = 'impression')::int, 0, 0, 0
        FROM ads_interactions i
        JOIN ads_serves s ON s.id = i.serve_id AND s.inventory_class IN ('paid', 'bonus_promo') AND s.delivery_mode = 'normal'
        JOIN ads_campaigns campaign ON campaign.id = s.campaign_id
        WHERE ${advertiser} AND campaign.advertiser_id = ${owner}
          AND i.is_valid AND i.promoter_id = s.promoter_id AND i.type = 'impression'
          AND i.created_at >= ${start} AND i.created_at < ${end}
        UNION ALL
        SELECT click.at, click.campaign_id, s.creative_id,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 1, (click.valid is true)::int, (${billedClick})::int
        FROM (${observedClickRows({ campaign: sql`select id from ads_campaigns where advertiser_id = ${owner}`,
          from: first + 'T00:00:00+01:00', to: now < new Date(range.until + 'T00:00:00+01:00')
            ? now.toISOString() : range.until + 'T00:00:00+01:00' })}) click
        LEFT JOIN ads_serves s ON s.id = click.serve_id
        WHERE ${advertiser}
        UNION ALL
        SELECT t.created_at, campaign.id, null::uuid,
          0, 0, 0, 0,
          CASE WHEN t.type = 'ads_spend' THEN t.amount_usd_cents::numeric * 10000000 ELSE 0 END,
          CASE WHEN t.type = 'internal_credit' THEN t.amount_usd_cents::numeric * 10000000 ELSE 0 END,
          0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0, 0
        FROM billing_transactions t
        JOIN ads_campaigns campaign ON campaign.id::text = (t.metadata::jsonb)->>'campaignId'
        WHERE ${advertiser} AND t.user_id = ${owner} AND campaign.advertiser_id = ${owner}
          AND t.status = 'completed' AND t.provider = 'internal'
          AND (t.type = 'ads_spend' OR (t.type = 'internal_credit' AND t.idempotency_key LIKE 'ads-rejection:v1:%'))
          AND t.created_at >= ${start} AND t.created_at < ${end}
        UNION ALL
        SELECT t.created_at, item.campaign_id, s.creative_id,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          -t.amount_usd_cents::numeric * 10000000,
          0, 0, 0, 0, 0, 0, 0, 0
        FROM billing_transactions t
        JOIN ads_promoter_settlement_items item ON item.id::text = (t.metadata::jsonb)->>'itemId'
        JOIN ads_promoters publisher ON publisher.id = item.promoter_id
        LEFT JOIN ads_settlement_claims claim ON item.idempotency_key = 'ads-item:v3:' || claim.interaction_id::text
        LEFT JOIN ads_serves s ON s.id = claim.serve_id
        WHERE ${!advertiser} AND t.user_id = ${owner} AND publisher.user_id = ${owner}
          AND t.status = 'completed' AND t.provider = 'internal' AND t.idempotency_key LIKE 'ads-recovery:v1:%'
          AND t.created_at >= ${start} AND t.created_at < ${end}
        UNION ALL
        -- PLAN-0155 G09: Bonus-credit campaign spend (advertiser) & pending promotional earnings (promoter)
        SELECT b.created_at, b.campaign_id, coalesce(b.creative_id, s.creative_id),
          0, 0, 0,
          ${advertiser ? sql`(b.face_value_microusd::numeric * 1000)` : sql`0`},
          0, 0, 0, 0, 0,
          ${advertiser ? sql`0` : sql`CASE WHEN b.clearance_status = 'pending' THEN (b.promoter_earnings_microusd::numeric * 1000) ELSE 0 END`},
          0,
          0,
          ${advertiser ? sql`1` : sql`0`},
          ${advertiser ? sql`0` : sql`1`},
          0, 0, 0, 0, 0
        FROM bonus_promo_impressions b
        JOIN ads_serves s ON s.id = b.serve_id
        JOIN ads_campaigns campaign ON campaign.id = b.campaign_id
        JOIN ads_promoters publisher ON publisher.id = b.promoter_id
        WHERE ${ownerFilter}
          AND b.clearance_status <> 'invalidated'
          AND b.created_at >= ${start} AND b.created_at < ${end}
        UNION ALL
        -- PLAN-0155 G09: Confirmed Billing wallet payouts from Promotional Ad Reserve (reconciles 1:1 to Billing receipts)
        SELECT t.created_at, null::uuid, null::uuid,
          0, 0, 0, 0, 0, 0, 0, 0,
          t.amount_usd_cents::numeric * 10000000,
          0, 0,
          0, 0, 0, 0, 0, 0, 0, 0
        FROM billing_transactions t
        WHERE ${!advertiser}
          AND t.user_id = ${owner}
          AND t.type = 'ads_earning'
          AND t.provider = 'internal'
          AND t.status = 'completed'
          AND (t.metadata::jsonb)->>'kind' = 'bonus_promo_earning'
          AND t.created_at >= ${start} AND t.created_at < ${end}
      )
      SELECT to_char(entries.at AT TIME ZONE ${REPORT_ZONE}, 'YYYY-MM-DD') AS day,
        entries.campaign_id AS "campaignId", entries.creative_id AS "creativeId",
        ${advertiser ? sql`campaign.title` : sql`null::text`} AS campaign,
        ${advertiser ? sql`creative.headline` : sql`null::text`} AS creative,
        ${sql.join(projections, sql`, `)}
      FROM entries
      LEFT JOIN ads_campaigns campaign ON campaign.id = entries.campaign_id
      LEFT JOIN ads_creatives creative ON creative.id = entries.creative_id AND creative.campaign_id = entries.campaign_id
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1, 2, 3
      LIMIT 10001
    `);
    if (results.rows.length > 10_000) throw new ServiceUnavailableException('Choose a shorter report period.');
    const days = new Map(range.dates.map(date => [date, { date, incomplete: date === range.today, ...emptyReportMetrics() }]));
    const totals = emptyReportMetrics();
    const previous = compare ? emptyReportMetrics() : null;
    const breakdown = new Map<string, Omit<ReportRow, 'day'>>();
    for (const { day, campaignId, creativeId, campaign, creative, ...metrics } of results.rows) {
      const daily = days.get(day);
      if (!daily) {
        if (previous) addReportMetrics(previous, metrics);
        continue;
      }
      addReportMetrics(daily, metrics);
      addReportMetrics(totals, metrics);
      const key = `${campaignId ?? ''}:${creativeId ?? ''}`;
      const group = breakdown.get(key) ?? { campaignId, creativeId, campaign, creative, ...emptyReportMetrics() };
      addReportMetrics(group, metrics);
      breakdown.set(key, group);
    }
    return {
      role, timezone: REPORT_ZONE, updatedAt: now.toISOString(), from: range.from, to: range.to,
      daily: [...days.values()].map(({ date, incomplete, ...values }) => ({ date, incomplete, ...serializeMetrics(values) })),
      totals: serializeMetrics(totals),
      breakdown: [...breakdown.values()].map(({ campaignId, creativeId, campaign, creative, ...values }) => ({
        ...(advertiser
          ? { campaignId, creativeId, campaign, creative }
          : { campaignId: reportReference(owner, 'campaign', campaignId), creativeId: reportReference(owner, 'ad', creativeId) }),
        ...serializeMetrics(values),
      })),
      comparison: previous && { from: range.previousFrom, to: range.previousTo, totals: serializeMetrics(previous) },
    };
  }
}
