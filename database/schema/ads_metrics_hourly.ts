import { pgTable, uuid, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { adsCampaigns } from './ads_campaigns';
import { adsCreatives } from './ads_creatives';
import { adsPromoters, adsPlacements } from './ads_promoters';

/**
 * ads_metrics_hourly
 *
 * Pre-aggregated hourly metrics rollup table populated by the background
 * batch audit cron runner (every 30 to 60 mins).
 *
 * Speeds up dashboard queries by avoiding expensive dynamic COUNT(*) scans
 * over millions of raw interaction log rows.
 */
export const adsMetricsHourly = pgTable(
  'ads_metrics_hourly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'cascade' }),
    creativeId: uuid('creative_id').references(() => adsCreatives.id, { onDelete: 'cascade' }),
    promoterId: uuid('promoter_id').references(() => adsPromoters.id, { onDelete: 'set null' }),
    placementId: uuid('placement_id').references(() => adsPlacements.id, { onDelete: 'set null' }),

    // Hourly bucket timestamp (truncated to the start of the hour)
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),

    // Aggregated engagement counters
    impressionsCount: integer('impressions_count').notNull().default(0),
    clicksCount: integer('clicks_count').notNull().default(0),
    hoversCount: integer('hovers_count').notNull().default(0),
    touchesCount: integer('touches_count').notNull().default(0),

    // Financial calculations (in integer USD cents)
    spendUsdCents: integer('spend_usd_cents').notNull().default(0),
    earningsUsdCents: integer('earnings_usd_cents').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_metrics_hourly_campaign_id_idx').on(t.campaignId),
    index('ads_metrics_hourly_promoter_id_idx').on(t.promoterId),
    index('ads_metrics_hourly_period_start_idx').on(t.periodStart),
    unique('ads_metrics_hourly_rollup_uniq').on(t.campaignId, t.creativeId, t.placementId, t.periodStart),
  ],
);

export type AdsMetricsHourly = typeof adsMetricsHourly.$inferSelect;
export type NewAdsMetricsHourly = typeof adsMetricsHourly.$inferInsert;
