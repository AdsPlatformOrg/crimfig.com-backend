import { pgTable, uuid, bigint, integer, timestamp, unique } from 'drizzle-orm/pg-core';
import { adsInteractions } from './ads_interactions';
import { adsServes } from './ads_serves_and_assets';
import { adsCampaignEscrows } from './ads_campaign_escrows';
import { adsPromoters } from './ads_promoters';
import { adsSettlementBatches } from './ads_settlement_batches';

/** Immutable ownership of an eligible event. One serve can fund at most one pricing event. */
export const adsSettlementClaims = pgTable('ads_settlement_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  interactionId: uuid('interaction_id').notNull().unique().references(() => adsInteractions.id, { onDelete: 'restrict' }),
  serveId: uuid('serve_id').notNull().unique().references(() => adsServes.id, { onDelete: 'restrict' }),
  escrowId: uuid('escrow_id').notNull().references(() => adsCampaignEscrows.id, { onDelete: 'restrict' }),
  allocatedUsdCents: bigint('allocated_usd_cents', { mode: 'number' }).notNull(),
  promoterId: uuid('promoter_id').notNull().references(() => adsPromoters.id, { onDelete: 'restrict' }),
  batchId: uuid('batch_id').notNull().references(() => adsSettlementBatches.id, { onDelete: 'restrict' }),
  priceNanos: bigint('price_nanos', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Precision accumulator only; Billing transactions/escrow remain the money authority. */
export const adsSettlementCarries = pgTable('ads_settlement_carries', {
  id: uuid('id').primaryKey().defaultRandom(),
  escrowId: uuid('escrow_id').notNull().references(() => adsCampaignEscrows.id, { onDelete: 'restrict' }),
  allocatedUsdCents: bigint('allocated_usd_cents', { mode: 'number' }).notNull(),
  promoterId: uuid('promoter_id').notNull().references(() => adsPromoters.id, { onDelete: 'restrict' }),
  carryNanos: bigint('carry_nanos', { mode: 'bigint' }).notNull().default(0n),
  billedUsdCents: integer('billed_usd_cents').notNull().default(0),
  publisherUsdCents: integer('publisher_usd_cents').notNull().default(0),
  commissionPoolUsdCents: integer('commission_pool_usd_cents').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('ads_settlement_carry_generation_unique').on(table.escrowId, table.allocatedUsdCents, table.promoterId)]);
