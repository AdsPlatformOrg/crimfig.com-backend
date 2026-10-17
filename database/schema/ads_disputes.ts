import { pgTable, uuid, varchar, text, bigint, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';

/**
 * ads_dispute_role
 */
export const disputeRoleEnum = pgEnum('ads_dispute_role', ['advertiser', 'promoter']);

/**
 * ads_dispute_status
 */
export const disputeStatusEnum = pgEnum('ads_dispute_status', [
  'open',
  'under_review',
  'resolved_upheld',
  'resolved_adjusted',
  'rejected',
]);

/**
 * ads_disputes
 *
 * Formal audit and dispute resolution table for advertisers (reporting invalid clicks/bot surges)
 * and promoters (appealing false-positive invalidations or traffic flags).
 * Settlements are executed strictly as append-only ledger entries in monetization_settlement_entries.
 */
export const adsDisputes = pgTable(
  'ads_disputes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    openedBy: uuid('opened_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: disputeRoleEnum('role').notNull(),
    scope: varchar('scope', { length: 30 }).notNull().default('campaign'), // 'campaign' | 'placement' | 'general'

    campaignId: uuid('campaign_id').references(() => adsCampaigns.id, { onDelete: 'set null' }),
    placementId: varchar('placement_id', { length: 100 }),

    periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
    periodTo: timestamp('period_to', { withTimezone: true }).notNull(),

    reason: text('reason').notNull(),
    details: text('details').notNull(),

    status: disputeStatusEnum('status').notNull().default('open'),
    outcome: text('outcome'),
    adjustmentMicros: bigint('adjustment_micros', { mode: 'number' }),

    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_disputes_opened_by_idx').on(t.openedBy),
    index('ads_disputes_campaign_id_idx').on(t.campaignId),
    index('ads_disputes_status_idx').on(t.status),
    index('ads_disputes_created_at_idx').on(t.createdAt),
  ],
);

export type AdsDispute = typeof adsDisputes.$inferSelect;
export type NewAdsDispute = typeof adsDisputes.$inferInsert;
