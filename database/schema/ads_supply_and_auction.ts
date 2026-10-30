import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';
import { adsCreatives } from './ads_creatives';
import { adsPromoters, adsPromoterWebsites } from './ads_promoters';
import { adstationSlots } from './adstation';
import { adsCampaignEscrows } from './ads_campaign_escrows';

/**
 * ads_auction_decisions (PLAN-0047 / PLAN-0049)
 *
 * Append-only, tamper-evident decision ledger for every supply admission and
 * auction resolution (paid, simulated_paid, shadow, house, no_fill).
 * Supports deterministic replay via replayAuctionDecision().
 */
export const adsAuctionDecisions = pgTable(
  'ads_auction_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').notNull().unique(),
    serveId: uuid('serve_id'),

    promoterId: uuid('promoter_id').references(() => adsPromoters.id, {
      onDelete: 'set null',
    }),
    websiteId: uuid('website_id').references(() => adsPromoterWebsites.id, {
      onDelete: 'set null',
    }),
    slotId: uuid('slot_id').references(() => adstationSlots.id, {
      onDelete: 'set null',
    }),
    slotTagId: varchar('slot_tag_id', { length: 64 }).notNull(),

    // 'house' | 'shadow' | 'direct' | 'paid' | 'simulated_paid' | 'no_fill'
    inventoryClass: varchar('inventory_class', { length: 24 })
      .notNull()
      .default('house'),
    // 'normal' | 'shadow' | 'no_fill'
    deliveryMode: varchar('delivery_mode', { length: 20 })
      .notNull()
      .default('normal'),
    // 'normal' | 'suspicious' | 'high_risk' | 'confirmed_fraud'
    trafficRiskStatus: varchar('traffic_risk_status', { length: 24 })
      .notNull()
      .default('normal'),
    // 'pending' | 'eligible' | 'quarantined' | 'invalid'
    financialEligibility: varchar('financial_eligibility', { length: 24 })
      .notNull()
      .default('invalid'),

    policyVersion: varchar('policy_version', { length: 32 })
      .notNull()
      .default('auction_v1'),
    bidderGroupingMode: varchar('bidder_grouping_mode', { length: 24 })
      .notNull()
      .default('advertiser'),
    tieSeed: varchar('tie_seed', { length: 64 }).notNull(),

    candidateCount: integer('candidate_count').notNull().default(0),
    eligibleGroupCount: integer('eligible_group_count').notNull().default(0),
    evaluatedCandidates: jsonb('evaluated_candidates').notNull().default([]),
    excludedCandidates: jsonb('excluded_candidates').notNull().default([]),

    winnerCampaignId: uuid('winner_campaign_id').references(
      () => adsCampaigns.id,
      { onDelete: 'set null' },
    ),
    winnerCreativeId: uuid('winner_creative_id').references(
      () => adsCreatives.id,
      { onDelete: 'set null' },
    ),
    runnerUpCampaignId: uuid('runner_up_campaign_id').references(
      () => adsCampaigns.id,
      { onDelete: 'set null' },
    ),

    pricingModel: varchar('pricing_model', { length: 20 })
      .notNull()
      .default('cpm'),
    clearingPriceMicros: bigint('clearing_price_micros', { mode: 'number' })
      .notNull()
      .default(0),
    billingPriceNanos: bigint('billing_price_nanos', { mode: 'bigint' })
      .notNull()
      .default(0n),

    opportunityReservationId: uuid('opportunity_reservation_id'),
    stageTimingsMs: jsonb('stage_timings_ms').notNull().default({}),

    previousHash: varchar('previous_hash', { length: 64 }),
    recordHash: varchar('record_hash', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ads_auction_decisions_slot_id_idx').on(t.slotId),
    index('ads_auction_decisions_website_id_idx').on(t.websiteId),
    index('ads_auction_decisions_winner_campaign_idx').on(t.winnerCampaignId),
    index('ads_auction_decisions_created_at_idx').on(t.createdAt),
  ],
);

/**
 * ads_opportunity_reservations (PLAN-0049)
 *
 * Per-opportunity funded exposure reservations.
 * Prevents concurrent ad serves from issuing unbacked payable tokens beyond
 * campaign remaining budget / hourly pacing.
 * Supports both real escrow-backed holds and isolated simulated mode (is_simulated = true).
 */
export const adsOpportunityReservations = pgTable(
  'ads_opportunity_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id').notNull().unique(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'cascade' }),
    escrowId: uuid('escrow_id').references(() => adsCampaignEscrows.id, {
      onDelete: 'set null',
    }),
    serveId: uuid('serve_id'),

    pricingModel: varchar('pricing_model', { length: 20 })
      .notNull()
      .default('cpm'),
    reservedNanos: bigint('reserved_nanos', { mode: 'bigint' })
      .notNull()
      .default(0n),
    reservedUsdCentsCeiling: integer('reserved_usd_cents_ceiling')
      .notNull()
      .default(0),

    // 'HELD' | 'ISSUED' | 'CLAIMED' | 'RELEASED' | 'EXPIRED'
    state: varchar('state', { length: 20 }).notNull().default('HELD'),
    isSimulated: boolean('is_simulated').notNull().default(false),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: varchar('release_reason', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ads_opp_res_campaign_state_idx').on(t.campaignId, t.state),
    index('ads_opp_res_expires_at_idx').on(t.expiresAt),
    index('ads_opp_res_serve_id_idx').on(t.serveId),
  ],
);

/**
 * ads_traffic_controls (PLAN-0047 / PLAN-0049)
 *
 * Granular operator/automated traffic controls at slot, website, or promoter scope.
 * Actions: 'SHADOW_SLOT' | 'QUARANTINE_TRAFFIC' | 'PAUSE_PAID_DELIVERY' | 'REQUIRE_REVERIFICATION' | 'SUSPEND_ACCOUNT'
 */
export const adsTrafficControls = pgTable(
  'ads_traffic_controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'slot' | 'website' | 'promoter' | 'campaign'
    targetScope: varchar('target_scope', { length: 24 }).notNull(),
    targetId: uuid('target_id').notNull(),
    action: varchar('action', { length: 40 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    reasonCode: varchar('reason_code', { length: 64 }).notNull(),
    internalNote: text('internal_note'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ads_traffic_controls_target_idx').on(
      t.targetScope,
      t.targetId,
      t.isActive,
    ),
  ],
);

/**
 * ads_supply_state_history (PLAN-0047)
 *
 * Immutable audit trail for promoter website policy transitions, slot lifecycle
 * changes, and traffic risk / financial eligibility transitions.
 */
export const adsSupplyStateHistory = pgTable(
  'ads_supply_state_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // 'website' | 'slot' | 'promoter' | 'serve'
    entityType: varchar('entity_type', { length: 24 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    dimension: varchar('dimension', { length: 32 }).notNull(), // 'policy_status' | 'lifecycle_status' | 'traffic_risk' | 'financial_eligibility'
    fromState: varchar('from_state', { length: 32 }),
    toState: varchar('to_state', { length: 32 }).notNull(),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorRole: varchar('actor_role', { length: 32 }).notNull().default('system'),
    reason: text('reason'),
    requestId: uuid('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ads_supply_state_history_entity_idx').on(
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
  ],
);

export type AdsAuctionDecision = typeof adsAuctionDecisions.$inferSelect;
export type NewAdsAuctionDecision = typeof adsAuctionDecisions.$inferInsert;
export type AdsOpportunityReservation =
  typeof adsOpportunityReservations.$inferSelect;
export type NewAdsOpportunityReservation =
  typeof adsOpportunityReservations.$inferInsert;
export type AdsTrafficControl = typeof adsTrafficControls.$inferSelect;
export type NewAdsTrafficControl = typeof adsTrafficControls.$inferInsert;
export type AdsSupplyStateHistory = typeof adsSupplyStateHistory.$inferSelect;
export type NewAdsSupplyStateHistory =
  typeof adsSupplyStateHistory.$inferInsert;

