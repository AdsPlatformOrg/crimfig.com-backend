import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';
import { adsCreatives } from './ads_creatives';
import { adsPromoters, adsPromoterWebsites } from './ads_promoters';
import { adsServes } from './ads_serves_and_assets';
import { adsInteractions } from './ads_interactions';
import { billingTransactions } from './billing_transactions';

/** Audited database-backed program switches controllable by Platform Admin without .env redeploys. */
export const programFeatureSwitches = pgTable('program_feature_switches', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  isLockedOff: boolean('is_locked_off').notNull().default(false),
  label: text('label').notNull(),
  description: text('description').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable audit trail of every Platform Admin switch toggle. */
export const programFeatureSwitchAudit = pgTable(
  'program_feature_switch_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    switchKey: text('switch_key')
      .notNull()
      .references(() => programFeatureSwitches.key, { onDelete: 'restrict' }),
    previousEnabled: boolean('previous_enabled').notNull(),
    nextEnabled: boolean('next_enabled').notNull(),
    reason: text('reason').notNull(),
    requestId: uuid('request_id').notNull().unique(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('program_switch_audit_key_idx').on(t.switchKey, t.createdAt)],
);

/** Platform Operating Reserve balance for inter-reserve management (USD cents). */
export const platformOperatingReserve = pgTable('platform_operating_reserve', {
  id: uuid('id').primaryKey().defaultRandom(),
  currency: text('currency').notNull().default('USD').unique(),
  availableCents: bigint('available_cents', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit log of inter-reserve fund movements by Platform Admin. */
export const platformReserveTransfers = pgTable(
  'platform_reserve_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').notNull().unique(),
    fromReserve: text('from_reserve').notNull(),
    toReserve: text('to_reserve').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sourceRef: text('source_ref'),
    reason: text('reason').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('platform_reserve_transfers_created_idx').on(t.createdAt)],
);

/** Claimed, non-expiring advertiser bonus ad credit wallets (one claim per milestone). */
export const advertiserBonusCredits = pgTable(
  'advertiser_bonus_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    milestoneId: text('milestone_id').notNull(),
    requestId: uuid('request_id').notNull().unique(),
    policyVersion: text('policy_version').notNull(),
    qualifyingSpendCents: bigint('qualifying_spend_cents', { mode: 'number' }).notNull(),
    creditCents: integer('credit_cents').notNull(),
    remainingCreditCents: integer('remaining_credit_cents').notNull(),
    reservedCreditCents: integer('reserved_credit_cents').notNull().default(0),
    consumedCreditCents: integer('consumed_credit_cents').notNull().default(0),
    state: text('state').notNull().default('available'),
    termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('advertiser_bonus_credits_owner_tier_uq').on(t.advertiserId, t.milestoneId),
    index('advertiser_bonus_credits_owner_idx').on(t.advertiserId, t.claimedAt),
  ],
);

/** Exact per-campaign per-grant allocation, consumption, and release tracking (PLAN-0155). */
export const advertiserBonusCampaignAllocations = pgTable(
  'advertiser_bonus_campaign_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'restrict' }),
    creditId: uuid('credit_id')
      .notNull()
      .references(() => advertiserBonusCredits.id, { onDelete: 'restrict' }),
    advertiserId: uuid('advertiser_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    allocatedCents: integer('allocated_cents').notNull(),
    reservedCents: integer('reserved_cents').notNull().default(0),
    consumedCents: integer('consumed_cents').notNull().default(0),
    releasedCents: integer('released_cents').notNull().default(0),
    consumedMicrousd: bigint('consumed_microusd', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('advertiser_bonus_campaign_alloc_uq').on(t.campaignId, t.creditId),
    index('advertiser_bonus_campaign_alloc_campaign_idx').on(t.campaignId),
  ],
);

/** Append-only advertiser bonus credit movement ledger. */
export const advertiserBonusLedger = pgTable(
  'advertiser_bonus_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    creditId: uuid('credit_id').references(() => advertiserBonusCredits.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => adsCampaigns.id, { onDelete: 'set null' }),
    requestId: uuid('request_id').notNull().unique(),
    kind: text('kind').notNull(),
    amountCents: integer('amount_cents').notNull(),
    balanceAfterCents: integer('balance_after_cents').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('advertiser_bonus_ledger_owner_idx').on(t.advertiserId, t.createdAt)],
);

/** Non-blocking silent safety alerts for Platform Admin review. */
export const platformAdminSilentAlerts = pgTable(
  'platform_admin_silent_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: text('category').notNull(),
    severity: text('severity').notNull().default('info'),
    advertiserId: uuid('advertiser_id').references(() => users.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => adsCampaigns.id, { onDelete: 'set null' }),
    milestoneId: text('milestone_id'),
    summary: text('summary').notNull(),
    details: jsonb('details').notNull().default({}),
    status: text('status').notNull().default('open'),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('platform_admin_silent_alerts_status_idx').on(t.status, t.createdAt)],
);

/** Viewable bonus-promo impressions and 55% promotional reserve promoter earnings (72h clearance). */
export const bonusPromoImpressions = pgTable(
  'bonus_promo_impressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serveId: uuid('serve_id')
      .notNull()
      .unique()
      .references(() => adsServes.id, { onDelete: 'restrict' }),
    interactionId: uuid('interaction_id')
      .notNull()
      .unique()
      .references(() => adsInteractions.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'restrict' }),
    creativeId: uuid('creative_id').references(() => adsCreatives.id, { onDelete: 'set null' }),
    advertiserId: uuid('advertiser_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    promoterId: uuid('promoter_id')
      .notNull()
      .references(() => adsPromoters.id, { onDelete: 'restrict' }),
    websiteId: uuid('website_id')
      .notNull()
      .references(() => adsPromoterWebsites.id, { onDelete: 'restrict' }),
    faceValueMicrousd: bigint('face_value_microusd', { mode: 'number' }).notNull(),
    promoterEarningsMicrousd: bigint('promoter_earnings_microusd', { mode: 'number' }).notNull(),
    clearanceStatus: text('clearance_status').notNull().default('pending'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    payoutBatchId: uuid('payout_batch_id'),
    billingTransactionId: uuid('billing_transaction_id').references(() => billingTransactions.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bonus_promo_impressions_clearance_idx').on(t.clearanceStatus, t.holdExpiresAt),
    index('bonus_promo_impressions_campaign_created_idx').on(t.campaignId, t.createdAt),
    index('bonus_promo_impressions_promoter_created_idx').on(t.promoterId, t.createdAt),
  ],
);

/** Durable sub-cent microUSD residual carry per promoter for bonus promotional ad earnings (PLAN-0155). */
export const bonusPromoPromoterCarries = pgTable('bonus_promo_promoter_carries', {
  promoterId: uuid('promoter_id')
    .primaryKey()
    .references(() => adsPromoters.id, { onDelete: 'restrict' }),
  carryMicrousd: bigint('carry_microusd', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
