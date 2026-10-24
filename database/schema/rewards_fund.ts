import { pgTable, uuid, text, varchar, integer, bigint, boolean, timestamp, pgEnum, index, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * rewards_fund_ledger_type_enum
 *
 * Types of movements in the append-only Rewards Fund cash ledger:
 *  - sweep_in: 10% auto-sweep from settled dynamic pool (PLAN-0016 §5.2)
 *  - allocate: cash moved from available to allocated (or funded_pending) to back point grants 1:1
 *  - release: cash returned from allocated/pending to available (e.g. expired points, fraud reversal)
 *  - spend: cash permanently debited upon point redemption (wallet cash-out, ad credit escrow, subscription)
 *  - adjust_in: dual-approved admin top-up
 *  - adjust_out: dual-approved admin withdrawal back to general reserves
 */
export const rewardsFundLedgerTypeEnum = pgEnum('rewards_fund_ledger_type', [
  'sweep_in',
  'allocate',
  'release',
  'spend',
  'adjust_in',
  'adjust_out',
]);

/**
 * rewards_proposal_status_enum
 */
export const rewardsProposalStatusEnum = pgEnum('rewards_proposal_status', [
  'pending',
  'approved',
  'rejected',
  'executed',
  'cancelled',
]);

/**
 * rewards_fund
 *
 * Singleton or per-currency master fund balance table.
 * All amounts stored as integer USD cents or integer microdollars. Zero floating point.
 * Enforces strict 5-balance solvency invariant:
 * cash_balance_usd_cents == allocated_usd_cents + available_usd_cents + funded_pending_usd_cents
 */
export const rewardsFund = pgTable(
  'rewards_fund',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currency: varchar('currency', { length: 10 }).notNull().default('USD').unique(),

    // Total unallocated or allocated real cash held in custody
    cashBalanceUsdCents: bigint('cash_balance_usd_cents', { mode: 'number' }).notNull().default(0),

    // Real cash backing points issued to users and currently available for redemption
    allocatedUsdCents: bigint('allocated_usd_cents', { mode: 'number' }).notNull().default(0),

    // Unallocated cash available to back new point emissions
    availableUsdCents: bigint('available_usd_cents', { mode: 'number' }).notNull().default(0),

    // Real cash reserved 1:1 backing points currently in the 72-hour fraud/settlement hold
    fundedPendingUsdCents: bigint('funded_pending_usd_cents', { mode: 'number' }).notNull().default(0),

    // Total cumulative spent cash through settled redemptions
    spentUsdCents: bigint('spent_usd_cents', { mode: 'number' }).notNull().default(0),

    // Configurable reserve floor buffer locked from point emissions
    reserveFloorUsdCents: bigint('reserve_floor_usd_cents', { mode: 'number' }).notNull().default(10000), // $100 default

    // Fractional microdollar residual accumulator ($0.000001 precision, 10,000 units = 1 integer cent)
    fractionalResidualMicrousd: bigint('fractional_residual_microusd', { mode: 'number' }).notNull().default(0),

    // Version for optimistic concurrency control
    version: integer('version').notNull().default(0),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_fund_currency_idx').on(t.currency),
  ],
);

/**
 * rewards_fund_ledger
 *
 * Append-only immutable transaction log of all money movements in and out of the Rewards Fund.
 */
export const rewardsFundLedger = pgTable(
  'rewards_fund_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fundId: uuid('fund_id').notNull().references(() => rewardsFund.id),
    type: rewardsFundLedgerTypeEnum('type').notNull(),

    // Delta amount in integer USD cents
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),

    // Source bucket ('available', 'allocated', 'funded_pending', 'spent', 'external')
    fromBucket: varchar('from_bucket', { length: 32 }).notNull(),
    toBucket: varchar('to_bucket', { length: 32 }).notNull(),

    // Post-transaction balance snapshot for reconciliation auditing
    cashBalanceAfterCents: bigint('cash_balance_after_cents', { mode: 'number' }).notNull(),
    availableAfterCents: bigint('available_after_cents', { mode: 'number' }).notNull(),
    allocatedAfterCents: bigint('allocated_after_cents', { mode: 'number' }).notNull(),
    fundedPendingAfterCents: bigint('funded_pending_after_cents', { mode: 'number' }).notNull(),

    // Context / traceability
    sourceRef: varchar('source_ref', { length: 128 }).notNull(), // e.g. 'batch:BATCH-1234', 'redemption:RED-5678'
    description: text('description'),
    actorId: uuid('actor_id').references(() => users.id), // null for automated system tasks

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_fund_ledger_fund_id_idx').on(t.fundId),
    index('rewards_fund_ledger_source_ref_idx').on(t.sourceRef),
    index('rewards_fund_ledger_created_at_idx').on(t.createdAt),
  ],
);

/**
 * rewards_fund_settings
 *
 * Current and historical settings for the rewards fund and issuance caps.
 */
export const rewardsFundSettings = pgTable(
  'rewards_fund_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version: integer('version').notNull().unique(),
    isActive: boolean('is_active').notNull().default(false),

    // Sweeps & reserve parameters
    rewardsFundSeedPercent: integer('rewards_fund_seed_percent').notNull().default(10), // 10% of settled net dynamic pool
    bonusPromoterIncentivePercent: integer('bonus_promoter_incentive_percent').notNull().default(5), // 5% dedicated reserve
    reserveFloorPercent: integer('reserve_floor_percent').notNull().default(20), // 20% safety buffer
    reserveFloorMinCents: integer('reserve_floor_min_cents').notNull().default(10000), // $100

    // Emission caps
    dailyEmissionCapPoints: integer('daily_emission_cap_points').notNull().default(50000),
    monthlyEmissionCapPoints: integer('monthly_emission_cap_points').notNull().default(1000000),
    perUserDailyCapPoints: integer('per_user_daily_cap_points').notNull().default(200),
    perUserMonthlyCapPoints: integer('per_user_monthly_cap_points').notNull().default(3000),

    // Redemption thresholds
    minRedemptionPoints: integer('min_redemption_points').notNull().default(1000), // 1,000 pts = $10.00
    highValueReviewPoints: integer('high_value_review_points').notNull().default(2000), // 2,000 pts = $20.00
    pendingHoldHours: integer('pending_hold_hours').notNull().default(72),
    pointsExpiryDays: integer('points_expiry_days').notNull().default(365),

    // Global kill-switch / suspension
    adsRewardsGlobalPaused: boolean('ads_rewards_global_paused').notNull().default(false),

    approvedBy: text('approved_by').array().notNull(), // IDs of 2 admins for dual-approval
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_fund_settings_version_idx').on(t.version),
  ],
);

/**
 * rewards_settings_proposals
 *
 * Dual-admin proposal table for changing fund settings or approving manual fund adjustments.
 */
export const rewardsSettingsProposals = pgTable(
  'rewards_settings_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalType: varchar('proposal_type', { length: 64 }).notNull(), // 'settings_update' | 'fund_topup' | 'fund_withdrawal'
    proposedPayload: jsonb('proposed_payload').notNull(),
    status: rewardsProposalStatusEnum('status').notNull().default('pending'),

    proposerId: uuid('proposer_id').notNull().references(() => users.id),
    approverId: uuid('approver_id').references(() => users.id), // Must differ from proposerId

    proposerNote: text('proposer_note'),
    approverNote: text('approver_note'),

    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_settings_proposals_status_idx').on(t.status),
  ],
);

/**
 * ads_rewards_suspension_audit
 *
 * Audit log for global or per-user rewards suspension actions.
 */
export const adsRewardsSuspensionAudit = pgTable(
  'ads_rewards_suspension_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 32 }).notNull(), // 'global' | 'user'
    targetUserId: uuid('target_user_id').references(() => users.id), // null if global
    action: varchar('action', { length: 32 }).notNull(), // 'pause' | 'resume'
    reason: text('reason').notNull(),
    performedBy: uuid('performed_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_rewards_suspension_audit_target_idx').on(t.targetUserId),
  ],
);

export type RewardsFund = typeof rewardsFund.$inferSelect;
export type NewRewardsFund = typeof rewardsFund.$inferInsert;
export type RewardsFundLedger = typeof rewardsFundLedger.$inferSelect;
export type NewRewardsFundLedger = typeof rewardsFundLedger.$inferInsert;
export type RewardsFundSettings = typeof rewardsFundSettings.$inferSelect;
export type NewRewardsFundSettings = typeof rewardsFundSettings.$inferInsert;
