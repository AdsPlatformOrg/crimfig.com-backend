import { pgTable, uuid, text, integer, bigint, numeric, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { billingTransactions } from './billing_transactions';

/**
 * monetization_products
 *
 * Master registry of monetization products across the CrimFig ecosystem.
 * Enables product-neutral revenue policies and financial tracking.
 * Examples: Ads, Reels, Chat, Subscriptions, Performance Affiliates, Games.
 */
export const monetizationProducts = pgTable(
  'monetization_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(), // 'ads' | 'reels' | 'chat' | 'subscriptions' | 'games' | 'performance'
    name: text('name').notNull(),
    description: text('description'),
    earningModel: text('earning_model').notNull().default('qualified_interactions'),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_products_code_idx').on(t.code),
    index('monetization_products_is_active_idx').on(t.isActive),
  ],
);

/**
 * monetization_tiers
 *
 * Standardized creator and publisher tier classifications.
 * Examples: Standard, Silver, Gold, Platinum.
 */
export const monetizationTiers = pgTable(
  'monetization_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(), // 'standard' | 'silver' | 'gold' | 'platinum'
    name: text('name').notNull(),
    description: text('description'),
    priority: integer('priority').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_tiers_code_idx').on(t.code),
    index('monetization_tiers_priority_idx').on(t.priority),
  ],
);

/**
 * monetization_revenue_policies
 *
 * Configurable publisher, platform, and commission percentages by product and tier.
 * Keeps revenue splits decoupled from code constants and configurable over time.
 */
export const monetizationRevenuePolicies = pgTable(
  'monetization_revenue_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => monetizationProducts.id, { onDelete: 'restrict' }),
    tierId: uuid('tier_id')
      .notNull()
      .references(() => monetizationTiers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),

    // Primary distribution ratios (e.g. 0.5500, 0.3000, 0.1500)
    publisherShareRatio: numeric('publisher_share_ratio', { precision: 5, scale: 4 }).notNull(),
    platformShareRatio: numeric('platform_share_ratio', { precision: 5, scale: 4 }).notNull(),
    commissionPoolRatio: numeric('commission_pool_ratio', { precision: 5, scale: 4 }).notNull(),

    // Referral and marketing allocation caps
    maxExternalReferralRatio: numeric('max_external_referral_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.1500'),
    defaultExternalReferralRatio: numeric('default_external_referral_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.1000'),
    defaultInternalMarketingRatio: numeric('default_internal_marketing_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.0500'),

    // Separately budgeted performance bonus (protects the referral pool)
    performanceBonusRatio: numeric('performance_bonus_ratio', { precision: 5, scale: 4 })
      .notNull()
      .default('0.0000'),

    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_revenue_policies_product_tier_idx').on(t.productId, t.tierId),
    index('monetization_revenue_policies_is_active_idx').on(t.isActive),
  ],
);

/**
 * monetization_account_tiers
 *
 * Tracks which creator/publisher qualifies for which tier, with effective date spans.
 */
export const monetizationAccountTiers = pgTable(
  'monetization_account_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => monetizationProducts.id, { onDelete: 'restrict' }),
    tierId: uuid('tier_id')
      .notNull()
      .references(() => monetizationTiers.id, { onDelete: 'restrict' }),

    qualificationReason: text('qualification_reason'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),

    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_account_tiers_user_product_idx').on(t.userId, t.productId),
    index('monetization_account_tiers_is_active_idx').on(t.isActive),
  ],
);

/**
 * monetization_earning_events
 *
 * Product-neutral records of verified, billable/earning activity.
 * Interaction events (impressions, clicks, watch time) are verified before recording.
 */
export const monetizationEarningEvents = pgTable(
  'monetization_earning_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => monetizationProducts.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    eventReferenceId: text('event_reference_id'),
    eventType: text('event_type').notNull(), // 'ad_impression' | 'ad_click' | 'reel_view' | 'chat_sub' | 'affiliate_sale'
    verifiedUnits: integer('verified_units').notNull().default(1),

    // In bigint USD cents
    grossBillableUsdCents: bigint('gross_billable_usd_cents', { mode: 'number' }).notNull().default(0),

    status: text('status').notNull().default('verified'), // 'verified' | 'pending_audit' | 'flagged_fraud' | 'settled'
    metadata: jsonb('metadata'),
    idempotencyKey: text('idempotency_key').unique(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_earning_events_product_user_idx').on(t.productId, t.userId),
    index('monetization_earning_events_status_idx').on(t.status),
    index('monetization_earning_events_created_at_idx').on(t.createdAt),
  ],
);

/**
 * monetization_settlement_entries
 *
 * Immutable, product-neutral financial ledger of credits and debits.
 * Feeds from domain reporting batches (e.g. ads_settlement_batches) to serve as
 * the single cross-product source of financial truth.
 */
export const monetizationSettlementEntries = pgTable(
  'monetization_settlement_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryNumber: text('entry_number').notNull().unique(),

    productId: uuid('product_id')
      .notNull()
      .references(() => monetizationProducts.id, { onDelete: 'restrict' }),
    revenuePolicyId: uuid('revenue_policy_id')
      .references(() => monetizationRevenuePolicies.id, { onDelete: 'restrict' }),
    tierId: uuid('tier_id')
      .references(() => monetizationTiers.id, { onDelete: 'set null' }),

    // Beneficiary entity classification
    entityType: text('entity_type').notNull(), // 'creator' | 'platform' | 'external_referrer' | 'internal_marketing' | 'bonus_pool'
    beneficiaryUserId: uuid('beneficiary_user_id').references(() => users.id, { onDelete: 'restrict' }),

    sourceBatchId: text('source_batch_id'),
    sourceItemId: text('source_item_id'),

    direction: text('direction').notNull(), // 'credit' | 'debit'

    // Monetary amount in bigint USD cents
    amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

    // Point-in-time snapshot ratios
    publisherRatioSnapshot: numeric('publisher_ratio_snapshot', { precision: 5, scale: 4 }),
    platformRatioSnapshot: numeric('platform_ratio_snapshot', { precision: 5, scale: 4 }),
    commissionPoolRatioSnapshot: numeric('commission_pool_ratio_snapshot', { precision: 5, scale: 4 }),
    exchangeRateSnapshot: numeric('exchange_rate_snapshot', { precision: 12, scale: 4 }),

    idempotencyKey: text('idempotency_key').notNull().unique(),

    billingTransactionId: uuid('billing_transaction_id').references(() => billingTransactions.id, {
      onDelete: 'set null',
    }),

    // In-system settlement posting state
    status: text('status').notNull().default('posted'), // 'posted' | 'reconciled' | 'reversed'

    // Separate bank payout lifecycle status
    payoutStatus: text('payout_status').notNull().default('unpaid'), // 'unpaid' | 'in_wallet' | 'withdrawal_pending' | 'paid_out' | 'not_applicable'

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_settlement_entries_product_id_idx').on(t.productId),
    index('monetization_settlement_entries_beneficiary_user_idx').on(t.beneficiaryUserId),
    index('monetization_settlement_entries_source_batch_idx').on(t.sourceBatchId),
    index('monetization_settlement_entries_status_idx').on(t.status),
    index('monetization_settlement_entries_payout_status_idx').on(t.payoutStatus),
    index('monetization_settlement_entries_created_at_idx').on(t.createdAt),
  ],
);

/**
 * monetization_commission_rules
 *
 * Rules governing external and internal marketing commissions.
 */
export const monetizationCommissionRules = pgTable(
  'monetization_commission_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => monetizationProducts.id, { onDelete: 'restrict' }),
    ruleName: text('rule_name').notNull(),
    targetType: text('target_type').notNull(), // 'external_referrer' | 'internal_marketing'

    commissionPercent: numeric('commission_percent', { precision: 5, scale: 4 }).notNull(), // e.g. 0.1000 (10%)
    maxCapUsdCents: bigint('max_cap_usd_cents', { mode: 'number' }),
    durationDays: integer('duration_days'), // null = lifetime
    eligibilityCriteria: jsonb('eligibility_criteria'),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('monetization_commission_rules_product_target_idx').on(t.productId, t.targetType),
    index('monetization_commission_rules_is_active_idx').on(t.isActive),
  ],
);

export type MonetizationProduct = typeof monetizationProducts.$inferSelect;
export type NewMonetizationProduct = typeof monetizationProducts.$inferInsert;
export type MonetizationTier = typeof monetizationTiers.$inferSelect;
export type NewMonetizationTier = typeof monetizationTiers.$inferInsert;
export type MonetizationRevenuePolicy = typeof monetizationRevenuePolicies.$inferSelect;
export type NewMonetizationRevenuePolicy = typeof monetizationRevenuePolicies.$inferInsert;
export type MonetizationAccountTier = typeof monetizationAccountTiers.$inferSelect;
export type NewMonetizationAccountTier = typeof monetizationAccountTiers.$inferInsert;
export type MonetizationEarningEvent = typeof monetizationEarningEvents.$inferSelect;
export type NewMonetizationEarningEvent = typeof monetizationEarningEvents.$inferInsert;
export type MonetizationSettlementEntry = typeof monetizationSettlementEntries.$inferSelect;
export type NewMonetizationSettlementEntry = typeof monetizationSettlementEntries.$inferInsert;
export type MonetizationCommissionRule = typeof monetizationCommissionRules.$inferSelect;
export type NewMonetizationCommissionRule = typeof monetizationCommissionRules.$inferInsert;
