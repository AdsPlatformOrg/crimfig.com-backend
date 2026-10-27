import { pgTable, uuid, varchar, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { adsCampaigns } from './ads_campaigns';

/**
 * ads_creative_stacks
 *
 * Ordered, named groups of creatives inside one campaign. A stack is an
 * authoring/reporting container only: it has no budget, bid, escrow, or
 * independent auction participation.
 *
 * geoMode:
 *   inherit  -> use the campaign geographic targeting (default)
 *   global   -> explicitly unrestricted for this stack
 *   targeted -> use the stack rows in crimfig_geo_targets
 */
export const adsCreativeStacks = pgTable(
  'ads_creative_stacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 100 }).notNull(),
    position: integer('position').notNull(),

    // Optional non-financial overrides. Null means inherit the campaign value.
    geoMode: varchar('geo_mode', { length: 16 }).notNull().default('inherit'),
    targetDevices: text('target_devices'), // JSON stringified string[]
    targetHours: text('target_hours'), // JSON stringified number[]

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ads_creative_stacks_campaign_position_uq').on(t.campaignId, t.position),
    index('ads_creative_stacks_campaign_id_idx').on(t.campaignId),
  ],
);

export type AdsCreativeStack = typeof adsCreativeStacks.$inferSelect;
export type NewAdsCreativeStack = typeof adsCreativeStacks.$inferInsert;
