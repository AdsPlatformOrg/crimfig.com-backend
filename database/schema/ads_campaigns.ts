import { pgTable, uuid, varchar, text, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
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
  'active',
  'paused',
  'completed',
  'cancelled',
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
    budgetUsdCents: integer('budget_usd_cents').notNull(),

    // Remaining budget (decremented as impressions/clicks are charged)
    remainingBudgetUsdCents: integer('remaining_budget_usd_cents').notNull(),

    // Pricing model per event type
    costPerImpressionUsdCents: integer('cost_per_impression_usd_cents').notNull().default(1), // $0.01
    costPerClickUsdCents: integer('cost_per_click_usd_cents').notNull().default(10),          // $0.10

    format: adFormatEnum('format').notNull().default('card'),
    status: campaignStatusEnum('status').notNull().default('draft'),

    // Targeting metadata (JSON: categories, regions, keywords)
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
