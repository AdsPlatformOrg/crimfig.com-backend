import { pgTable, uuid, text, varchar, integer, bigint, numeric, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';
import { adsPromoters, adsPlacements } from './ads_promoters';
import { billingTransactions } from './billing_transactions';

/**
 * ads_settlement_batch_status
 *
 * Status states for 30-minute settlement run batches:
 *   processing → Currently calculating impression/click/interaction tallies
 *   completed  → Advertiser spends debited, promoter wallets credited, reconciliation clean
 *   failed     → Error occurred during batch debit/credit, flagged for retry
 */
export const adsSettlementBatchStatusEnum = pgEnum('ads_settlement_batch_status', [
  'processing',
  'completed',
  'failed',
]);

/**
 * ads_settlement_batches
 *
 * Immutable ledger of 30-minute batch reconciliations executed by DeferredAuditService.
 * Stores point-in-time snapshots of platform share constants and exchange rates.
 * All monetary amounts in bigint USD cents.
 */
export const adsSettlementBatches = pgTable(
  'ads_settlement_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchNumber: text('batch_number').notNull().unique(),

    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

    totalImpressions: integer('total_impressions').notNull().default(0),
    totalClicks: integer('total_clicks').notNull().default(0),
    totalHovers: integer('total_hovers').notNull().default(0),
    totalTouches: integer('total_touches').notNull().default(0),

    // Total USD cents debited from advertiser escrows (bigint mode number)
    totalDebitedUsdCents: bigint('total_debited_usd_cents', { mode: 'number' }).notNull().default(0),

    // Total USD cents credited to promoter wallets
    totalCreditedUsdCents: bigint('total_credited_usd_cents', { mode: 'number' }).notNull().default(0),

    // Total USD cents paid in referral/marketing commissions
    totalCommissionPaidUsdCents: bigint('total_commission_paid_usd_cents', { mode: 'number' }).notNull().default(0),

    // Immutable point-in-time audit snapshots (55% Publisher / 30% Base / 15% Comm Pool)
    publisherPoolRatio: numeric('publisher_pool_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.5500'),
    crimfigBaseRevenueRatio: numeric('crimfig_base_revenue_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.3000'),
    commissionPoolRatio: numeric('commission_pool_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.1500'),
    commissionPaidRatio: numeric('commission_paid_ratio', { precision: 5, scale: 4 }).default('0.0000'),
    crimfigTotalRetainedRatio: numeric('crimfig_total_retained_ratio', { precision: 5, scale: 4 }).default('0.4500'),

    // Preserved for migration backward compatibility & statutory fee breakdown
    platformShareRatio: numeric('platform_share_ratio', { precision: 5, scale: 4 }).default('0.3000'),
    taxAndFeesRatio: numeric('tax_and_fees_ratio', { precision: 5, scale: 4 }).default('0.0000'),

    exchangeRateSnapshot: numeric('exchange_rate_snapshot', { precision: 12, scale: 4 }),

    // Idempotency key preventing double execution on retry
    idempotencyKey: text('idempotency_key').unique(),

    status: adsSettlementBatchStatusEnum('status').notNull().default('processing'),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('ads_settlement_batches_number_idx').on(t.batchNumber),
    index('ads_settlement_batches_status_idx').on(t.status),
    index('ads_settlement_batches_created_at_idx').on(t.createdAt),
  ],
);

/**
 * ads_promoter_settlement_items
 *
 * Granular promoter breakdown within each settlement batch.
 * Stores point-in-time audit snapshots and feeds into shared monetization ledger.
 * Notice: onDelete 'restrict' to protect financial audit history.
 */
export const adsPromoterSettlementItems = pgTable(
  'ads_promoter_settlement_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => adsSettlementBatches.id, { onDelete: 'restrict' }),
    promoterId: uuid('promoter_id')
      .notNull()
      .references(() => adsPromoters.id, { onDelete: 'restrict' }),
    placementId: uuid('placement_id').references(() => adsPlacements.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'restrict' }),

    impressionsCount: integer('impressions_count').notNull().default(0),
    clicksCount: integer('clicks_count').notNull().default(0),
    hoversCount: integer('hovers_count').notNull().default(0),
    touchesCount: integer('touches_count').notNull().default(0),

    // Bigint USD cents
    earnedUsdCents: bigint('earned_usd_cents', { mode: 'number' }).notNull().default(0),
    billedUsdCents: bigint('billed_usd_cents', { mode: 'number' }).notNull().default(0),

    // Point-in-time policy and tier snapshot references
    revenuePolicyId: uuid('revenue_policy_id'),
    tierSnapshot: text('tier_snapshot').default('standard'),

    // Point-in-time snapshots for historical audit
    publisherPoolRatio: numeric('publisher_pool_ratio', { precision: 5, scale: 4 }).default('0.5500'),
    crimfigBaseRevenueRatio: numeric('crimfig_base_revenue_ratio', { precision: 5, scale: 4 }).default('0.3000'),
    commissionPoolRatio: numeric('commission_pool_ratio', { precision: 5, scale: 4 }).default('0.1500'),
    platformShareRatio: numeric('platform_share_ratio', { precision: 5, scale: 4 }).default('0.3000'),
    taxAndFeesRatio: numeric('tax_and_fees_ratio', { precision: 5, scale: 4 }).default('0.0000'),
    exchangeRateSnapshot: numeric('exchange_rate_snapshot', { precision: 12, scale: 4 }),

    // Linked billing transaction ID in billing_transactions
    billingTransactionId: uuid('billing_transaction_id').references(() => billingTransactions.id, {
      onDelete: 'set null',
    }),

    idempotencyKey: text('idempotency_key'),

    // 72-Hour Clearance Hold Policy
    clearanceStatus: text('clearance_status').notNull().default('pending'), // pending | cleared | penalized | clawed_back
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),

    status: text('status').notNull().default('credited'), // credited | pending | failed

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_promoter_settlement_items_batch_id_idx').on(t.batchId),
    index('ads_promoter_settlement_items_promoter_id_idx').on(t.promoterId),
    index('ads_promoter_settlement_items_campaign_id_idx').on(t.campaignId),
  ],
);

export type AdsSettlementBatch = typeof adsSettlementBatches.$inferSelect;
export type NewAdsSettlementBatch = typeof adsSettlementBatches.$inferInsert;
export type AdsPromoterSettlementItem = typeof adsPromoterSettlementItems.$inferSelect;
export type NewAdsPromoterSettlementItem = typeof adsPromoterSettlementItems.$inferInsert;

/**
 * ads_deep_audit_runs
 *
 * Immutable log of multi-tier background fraud inspection cycles (Tier 2 6-Hour Deep, Tier 3 15-Day, Tier 3 30-Day).
 */
export const adsDeepAuditRuns = pgTable(
  'ads_deep_audit_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runNumber: varchar('run_number', { length: 50 }).notNull().unique(), // e.g. DA-72H-20261017-0600
    auditLevel: varchar('audit_level', { length: 20 }).notNull(), // 'tier2_6h' | 'tier3_15d' | 'tier3_30d' | 'manual'
    lookbackHours: integer('lookback_hours').notNull().default(72),

    totalInteractionsAnalyzed: integer('total_interactions_analyzed').notNull().default(0),
    totalInvalidatedClicks: integer('total_invalidated_clicks').notNull().default(0),
    totalRebatesIssuedUsdCents: bigint('total_rebates_issued_usd_cents', { mode: 'number' }).notNull().default(0),
    totalPenaltiesIssuedUsdCents: bigint('total_penalties_issued_usd_cents', { mode: 'number' }).notNull().default(0),

    status: varchar('status', { length: 20 }).notNull().default('completed'), // 'running' | 'completed' | 'failed'
    notes: text('notes'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('ads_deep_audit_runs_level_idx').on(t.auditLevel),
    index('ads_deep_audit_runs_started_at_idx').on(t.startedAt),
  ],
);

export type AdsDeepAuditRun = typeof adsDeepAuditRuns.$inferSelect;
export type NewAdsDeepAuditRun = typeof adsDeepAuditRuns.$inferInsert;

/**
 * ads_settlement_rebates
 *
 * First-class financial transaction rebates issued to advertisers for clicks retrospectively invalidated by deep fraud audits.
 */
export const adsSettlementRebates = pgTable(
  'ads_settlement_rebates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auditRunId: uuid('audit_run_id').references(() => adsDeepAuditRuns.id, { onDelete: 'set null' }),
    billingTransactionId: uuid('billing_transaction_id').references(() => billingTransactions.id, { onDelete: 'set null' }),

    sourceProcessType: varchar('source_process_type', { length: 50 }).notNull(), // 'cron_6h_deep_audit' | 'cron_15d_audit' | 'cron_30d_audit' | 'manual'
    campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'restrict' }),
    advertiserId: uuid('advertiser_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    promoterId: uuid('promoter_id').references(() => adsPromoters.id, { onDelete: 'set null' }),

    rebateAmountUsdCents: bigint('rebate_amount_usd_cents', { mode: 'number' }).notNull(),
    rebateReasonCode: varchar('rebate_reason_code', { length: 50 }).notNull(),
    status: varchar('status', { length: 30 }).notNull().default('completed'), // 'completed' | 'pending_admin_signoff' | 'rejected_by_admin'

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_settlement_rebates_campaign_idx').on(t.campaignId),
    index('ads_settlement_rebates_advertiser_idx').on(t.advertiserId),
    index('ads_settlement_rebates_run_idx').on(t.auditRunId),
  ],
);

export type AdsSettlementRebate = typeof adsSettlementRebates.$inferSelect;
export type NewAdsSettlementRebate = typeof adsSettlementRebates.$inferInsert;

/**
 * ads_promoter_penalties
 *
 * Penalties charged to promoters for fraudulent clicks uncovered during extended (15d/30d) audits, offset against future earnings.
 */
export const adsPromoterPenalties = pgTable(
  'ads_promoter_penalties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoterId: uuid('promoter_id').notNull().references(() => adsPromoters.id, { onDelete: 'restrict' }),
    auditRunId: uuid('audit_run_id').references(() => adsDeepAuditRuns.id, { onDelete: 'set null' }),
    auditLevel: varchar('audit_level', { length: 20 }).notNull(), // 'day_15' | 'day_30' | 'manual'

    penaltyAmountUsdCents: bigint('penalty_amount_usd_cents', { mode: 'number' }).notNull(),
    recoveredAmountUsdCents: bigint('recovered_amount_usd_cents', { mode: 'number' }).notNull().default(0),

    status: varchar('status', { length: 30 }).notNull().default('outstanding'), // 'outstanding' | 'partially_recovered' | 'fully_recovered' | 'waived'
    reasonCode: varchar('reason_code', { length: 50 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_promoter_penalties_promoter_idx').on(t.promoterId),
    index('ads_promoter_penalties_status_idx').on(t.status),
  ],
);

export type AdsPromoterPenalty = typeof adsPromoterPenalties.$inferSelect;
export type NewAdsPromoterPenalty = typeof adsPromoterPenalties.$inferInsert;
