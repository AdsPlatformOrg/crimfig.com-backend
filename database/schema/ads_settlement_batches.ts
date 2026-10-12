import { pgTable, uuid, text, integer, bigint, numeric, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
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
