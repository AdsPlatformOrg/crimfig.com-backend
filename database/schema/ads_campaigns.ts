import { pgTable, uuid, varchar, text, bigint, smallint, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * ads_campaigns
 *
 * Ad campaign definitions created by Advertisers.
 * All monetary amounts in USD cents (integer, never floats).
 *
 * Budget validation: Before creating a campaign, ads-api checks the
 * advertiser's wallet balance via the Billing Internal Ecosystem API.
 *
 * cost_per_impression_usd_cents / cost_per_click_usd_cents:
 *   Set per campaign. Used by the earnings module to calculate
 *   how much to credit to promoter wallets on each tracked event.
 */
export const campaignStatusEnum = pgEnum('ads_campaign_status', [
  'draft',
  'under_review',
  'pending_manager_approval',
  'active',
  'paused',
  'rejected',
  'suspended',
  'trash',
  'completed',
  'cancelled',
]);

export const adsModerationStatusEnum = pgEnum('ads_moderation_status', [
  'draft',
  'pending_primary_review',
  'pending_manager_approval',
  'approved',
  'rejected',
]);

export const adFormatEnum = pgEnum('ads_format', [
  'banner',
  'card',
  'video',
  'interstitial',
]);

export const adsCampaigns = pgTable(
  'ads_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),

    // Total budget allocated for this campaign (USD cents)
    budgetUsdCents: bigint('budget_usd_cents', { mode: 'number' }).notNull(),

    // Daily budget cap (USD cents, nullable if unconstrained)
    dailyBudgetUsdCents: bigint('daily_budget_usd_cents', { mode: 'number' }),

    // Hourly budget pacing cap (USD cents, e.g. daily / 24)
    hourlyPacingUsdCents: bigint('hourly_pacing_usd_cents', { mode: 'number' }),

    // Remaining budget (decremented during 30-min settlement runs)
    remainingBudgetUsdCents: bigint('remaining_budget_usd_cents', { mode: 'number' }).notNull(),

    // Pricing model per event type
    // Version 1 historical bids are never interpreted as standard CPM without explicit review.
    pricingVersion: smallint('pricing_version').notNull().default(1),
    pricingModel: varchar('pricing_model', { length: 20 }).notNull().default('cpm'), // 'cpm' | 'cpc' | 'cpa' | 'cpcv'
    // Version 2: legacy column name stores USD cents PER 1,000 eligible impressions.
    costPerImpressionUsdCents: bigint('cost_per_impression_usd_cents', { mode: 'number' }).notNull().default(1), // $0.01
    costPerClickUsdCents: bigint('cost_per_click_usd_cents', { mode: 'number' }).notNull().default(10),          // $0.10
    targetCpaUsdCents: bigint('target_cpa_usd_cents', { mode: 'number' }),
    targetCpcvUsdCents: bigint('target_cpcv_usd_cents', { mode: 'number' }),
    attributionClickDays: smallint('attribution_click_days').notNull().default(7),
    attributionViewDays: smallint('attribution_view_days').notNull().default(0),

    format: adFormatEnum('format').notNull().default('card'),

    // Operational Status (strictly execution state: draft, active, paused, completed, cancelled)
    status: campaignStatusEnum('status').notNull().default('draft'),

    // Moderation & Compliance Status (strictly decoupled from delivery state)
    moderationStatus: adsModerationStatusEnum('moderation_status').notNull().default('draft'),

    // Dual-Reviewer Audit Trail
    primaryReviewerId: uuid('primary_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    primaryReviewedAt: timestamp('primary_reviewed_at', { withTimezone: true }),
    managerReviewerId: uuid('manager_reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    managerReviewedAt: timestamp('manager_reviewed_at', { withTimezone: true }),

    // Typed Targeting Constraints (replaces free-text JSON)
    targetCountries: text('target_countries'), // JSON stringified array of ISO-2 codes e.g. ["NG", "GH"]
    targetStates: text('target_states'),       // JSON stringified array of Nigerian states e.g. ["Lagos", "Abuja"]
    targetDevices: text('target_devices'),     // JSON stringified array e.g. ["desktop", "android", "ios"]
    targetHours: text('target_hours'),         // JSON stringified array of 0-23 hours
    frequencyCapPerDay: smallint('frequency_cap_per_day').notNull().default(5),

    // Legacy targeting metadata retained for backwards compatibility
    targeting: text('targeting'),

    // Campaign schedule
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),

    // Whether new promoters can apply to run this campaign
    acceptingPromoters: boolean('accepting_promoters').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_campaigns_advertiser_id_idx').on(t.advertiserId),
    index('ads_campaigns_status_idx').on(t.status),
  ],
);

export type AdsCampaign = typeof adsCampaigns.$inferSelect;
export type NewAdsCampaign = typeof adsCampaigns.$inferInsert;
