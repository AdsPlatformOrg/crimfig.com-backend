import { pgTable, uuid, text, varchar, integer, bigint, boolean, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * rewards_point_state_enum
 *
 * Append-only state transitions for reward point lots:
 *  - pending: point grant in 72-hour fraud/settlement hold, backed 1:1 by funded_pending_usd_cents
 *  - available: point grant cleared, backed 1:1 by allocated_usd_cents, spendable by user
 *  - redemption_reserved: point lot held during active redemption processing
 *  - redeemed: points permanently consumed and debited from Rewards Fund
 *  - reversed: point grant revoked due to fraud or dispute reversal, backing returned to available_usd_cents
 *  - expired: points unredeemed after 365 days, backing returned to available_usd_cents
 */
export const rewardsPointStateEnum = pgEnum('rewards_point_state', [
  'pending',
  'available',
  'redemption_reserved',
  'redeemed',
  'reversed',
  'expired',
]);

/**
 * rewards_redemption_type_enum
 */
export const rewardsRedemptionTypeEnum = pgEnum('rewards_redemption_type', [
  'wallet_credit',
  'ad_credit',
  'subscription',
]);

/**
 * rewards_redemption_status_enum
 */
export const rewardsRedemptionStatusEnum = pgEnum('rewards_redemption_status', [
  'requested',
  'reserved',
  'review_required',
  'processing',
  'completed',
  'rejected',
  'failed',
]);

/**
 * rewards_points_balances
 *
 * Materialized per-user point balance snapshot.
 * Reconciled against rewards_points_ledger.
 * 100 points = $1.00 USD (1 point = 1 cent).
 */
export const rewardsPointsBalances = pgTable(
  'rewards_points_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

    pendingPoints: integer('pending_points').notNull().default(0),
    availablePoints: integer('available_points').notNull().default(0),
    reservedPoints: integer('reserved_points').notNull().default(0),
    lifetimeEarnedPoints: integer('lifetime_earned_points').notNull().default(0),
    lifetimeRedeemedPoints: integer('lifetime_redeemed_points').notNull().default(0),

    // User-specific fractional microdollar reward value accumulator (PLAN-0016 §11.2)
    // 10,000 microdollars = 1 integer reward point ($0.01)
    accumulatedRewardMicrousd: bigint('accumulated_reward_microusd', { mode: 'number' }).notNull().default(0),

    // Targeted suspension flag for this individual user
    isRewardsSuspended: boolean('is_rewards_suspended').notNull().default(false),

    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_points_balances_user_id_idx').on(t.userId),
  ],
);

/**
 * rewards_points_ledger
 *
 * Append-only immutable ledger of all point grants, holds, conversions, and redemptions.
 * Strict idempotency enforced via idempotencyKey.
 */
export const rewardsPointsLedger = pgTable(
  'rewards_points_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lotId: varchar('lot_id', { length: 64 }).notNull(), // Grouping identifier for the lot
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    deltaPoints: integer('delta_points').notNull(),
    state: rewardsPointStateEnum('state').notNull(),

    activityCode: varchar('activity_code', { length: 64 }).notNull(), // e.g. 'promo_impressions_100', 'referral_qualified'
    sourceRef: varchar('source_ref', { length: 128 }).notNull(), // e.g. 'interaction:INT-1234', 'milestone:tier_1'
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull().unique(),

    // Cash-backing valuation
    valuationMicrousd: bigint('valuation_microusd', { mode: 'number' }).notNull(), // Microdollar backing value
    rateVersion: integer('rate_version').notNull().default(1),

    // Expiry date (typically created_at + 365 days)
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    clearedAt: timestamp('cleared_at', { withTimezone: true }), // Timestamp when promoted from pending to available
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_points_ledger_user_id_idx').on(t.userId),
    index('rewards_points_ledger_lot_id_idx').on(t.lotId),
    index('rewards_points_ledger_activity_code_idx').on(t.activityCode),
    index('rewards_points_ledger_state_idx').on(t.state),
    index('rewards_points_ledger_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * deferred_reward_entitlements
 *
 * Stores Category A milestone achievements achieved when Rewards Fund available cash was depleted (ACHIEVED_UNFUNDED state).
 * Permanent prestige badges are unlocked immediately on profile; points are queued here without creating synthetic cash debt.
 */
export const deferredRewardEntitlements = pgTable(
  'deferred_reward_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    rewardKey: varchar('reward_key', { length: 64 }).notNull(), // e.g. 'promo_impressions_1k'
    pointsEntitled: integer('points_entitled').notNull(),
    usdEquivalentCents: integer('usd_equivalent_cents').notNull(),

    badgeTitle: varchar('badge_title', { length: 128 }).notNull(),
    badgeIcon: varchar('badge_icon', { length: 32 }).notNull(),

    status: varchar('status', { length: 32 }).notNull().default('queued'), // 'queued' | 'funded' | 'cancelled'
    fundedAt: timestamp('funded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deferred_reward_entitlements_user_key_idx').on(t.userId, t.rewardKey),
    index('deferred_reward_entitlements_status_idx').on(t.status),
  ],
);

/**
 * rewards_badges
 *
 * User unlocked prestige milestone badges. Unlocked permanently regardless of point funding or redemption.
 */
export const rewardsBadges = pgTable(
  'rewards_badges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    badgeKey: varchar('badge_key', { length: 64 }).notNull(),
    badgeTitle: varchar('badge_title', { length: 128 }).notNull(),
    badgeIcon: varchar('badge_icon', { length: 32 }).notNull(),
    tier: integer('tier'),
    achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rewards_badges_user_key_idx').on(t.userId, t.badgeKey),
    index('rewards_badges_user_id_idx').on(t.userId),
  ],
);

/**
 * rewards_redemptions
 *
 * Redemption requests for points conversion to wallet credit, ad credit, or subscription.
 */
export const rewardsRedemptions = pgTable(
  'rewards_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: rewardsRedemptionTypeEnum('type').notNull(),
    status: rewardsRedemptionStatusEnum('status').notNull().default('requested'),

    pointsRedeemed: integer('points_redeemed').notNull(), // Must be >= 1000
    usdCentsAmount: integer('usd_cents_amount').notNull(), // points / 100

    destinationRef: varchar('destination_ref', { length: 128 }), // walletId, campaignId, or subscriptionId
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull().unique(),

    reviewerId: uuid('reviewer_id').references(() => users.id),
    reviewerNote: text('reviewer_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_redemptions_user_id_idx').on(t.userId),
    index('rewards_redemptions_status_idx').on(t.status),
  ],
);

export type RewardsPointsBalance = typeof rewardsPointsBalances.$inferSelect;
export type NewRewardsPointsBalance = typeof rewardsPointsBalances.$inferInsert;
export type RewardsPointsLedgerEntry = typeof rewardsPointsLedger.$inferSelect;
export type NewRewardsPointsLedgerEntry = typeof rewardsPointsLedger.$inferInsert;
export type DeferredRewardEntitlement = typeof deferredRewardEntitlements.$inferSelect;
export type NewDeferredRewardEntitlement = typeof deferredRewardEntitlements.$inferInsert;
export type RewardsBadge = typeof rewardsBadges.$inferSelect;
export type NewRewardsBadge = typeof rewardsBadges.$inferInsert;
export type RewardsRedemption = typeof rewardsRedemptions.$inferSelect;
export type NewRewardsRedemption = typeof rewardsRedemptions.$inferInsert;
