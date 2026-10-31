import { pgTable, uuid, bigint, timestamp, pgEnum, index, boolean } from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';

/**
 * ads_escrow_status
 *
 * Lifecycle states of an advertiser campaign escrow:
 *   active    → Funds currently reserved in billing wallet, available to be burned
 *   exhausted → Allocated budget completely consumed by settlements
 *   released  → Unconsumed funds refunded/unlocked back to advertiser available wallet
 */
export const adsEscrowStatusEnum = pgEnum('ads_escrow_status', [
  'active',
  'exhausted',
  'released',
]);

/**
 * ads_campaign_escrows
 *
 * Tracks locked advertiser budget for an active ad campaign.
 * All amounts in USD bigint cents (mode: number).
 */
export const adsCampaignEscrows = pgTable(
  'ads_campaign_escrows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // Total budget reserved from advertiser wallet (bigint mode number)
    allocatedUsdCents: bigint('allocated_usd_cents', { mode: 'number' }).notNull(),

    // Cumulative spend burned by settlements
    consumedUsdCents: bigint('consumed_usd_cents', { mode: 'number' }).notNull().default(0),

    // Funds returned to available balance upon pause, cancellation, or trash
    refundedUsdCents: bigint('refunded_usd_cents', { mode: 'number' }).notNull().default(0),

    status: adsEscrowStatusEnum('status').notNull().default('active'),

    releasePending: boolean('release_pending').notNull().default(false),

    lastSettledAt: timestamp('last_settled_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_campaign_escrows_campaign_id_idx').on(t.campaignId),
    index('ads_campaign_escrows_user_id_idx').on(t.userId),
    index('ads_campaign_escrows_status_idx').on(t.status),
  ],
);

export type AdsCampaignEscrow = typeof adsCampaignEscrows.$inferSelect;
export type NewAdsCampaignEscrow = typeof adsCampaignEscrows.$inferInsert;
