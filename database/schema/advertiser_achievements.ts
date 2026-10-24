import { pgTable, uuid, varchar, text, bigint, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const advertiserMilestoneTierEnum = pgEnum('advertiser_milestone_tier', [
  'A1_FIRST_CAMPAIGN',
  'A2_CONSISTENT',
  'A3_GROWTH',
  'A4_TRUSTED',
  'B1_LEGACY_5YR',
  'B2_LEGACY_10YR',
  'B3_LEGACY_15YR',
  'B4_LEGACY_20YR',
  'B5_LEGACY_25YR',
  'B6_LEGACY_30YR',
]);

/**
 * advertiser_promo_budget
 *
 * Dedicated, capped promotional budget ledger for non-cash bonus ad credits (PLAN-0017).
 * Strictly decoupled from the cash-backed promoter rewards fund.
 */
export const advertiserPromoBudget = pgTable(
  'advertiser_promo_budget',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    totalAllocatedCents: bigint('total_allocated_cents', { mode: 'number' }).notNull().default(0),
    issuedBonusCreditsCents: bigint('issued_bonus_credits_cents', { mode: 'number' }).notNull().default(0),
    consumedBonusCreditsCents: bigint('consumed_bonus_credits_cents', { mode: 'number' }).notNull().default(0),
    remainingPromoBudgetCents: bigint('remaining_promo_budget_cents', { mode: 'number' }).notNull().default(0),

    isIssuanceHalted: boolean('is_issuance_halted').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * advertiser_achievements
 *
 * Permanent prestige badges and non-cash bonus credits awarded to advertisers.
 */
export const advertiserAchievements = pgTable(
  'advertiser_achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: advertiserMilestoneTierEnum('tier').notNull(),
    badgeTitle: varchar('badge_title', { length: 100 }).notNull(),
    badgeIcon: varchar('badge_icon', { length: 50 }).notNull(),

    // Non-cash bonus ad credit grant (integer USD cents)
    bonusCreditCents: integer('bonus_credit_cents').notNull().default(0),
    bonusCreditRemainingCents: integer('bonus_credit_remaining_cents').notNull().default(0),
    creditExpiresAt: timestamp('credit_expires_at', { withTimezone: true }),

    // Compliance & Verification audit trail
    qualifyingSpendCents: bigint('qualifying_spend_cents', { mode: 'number' }).notNull().default(0),
    qualifyingCampaignCount: integer('qualifying_campaign_count').notNull().default(0),
    isClawedBack: boolean('is_clawed_back').notNull().default(false),
    clawbackReason: text('clawback_reason'),

    achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('advertiser_achievements_advertiser_id_idx').on(t.advertiserId),
    index('advertiser_achievements_tier_idx').on(t.tier),
  ],
);

export type AdvertiserPromoBudget = typeof advertiserPromoBudget.$inferSelect;
export type AdvertiserAchievement = typeof advertiserAchievements.$inferSelect;
export type NewAdvertiserAchievement = typeof advertiserAchievements.$inferInsert;
