import { pgTable, uuid, varchar, text, bigint, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { adsPromoters, adsPromoterWebsites } from './ads_promoters';

/**
 * adstation_slot_type
 *
 * Distinct inventory types:
 *   consideration -> Dedicated 100% to CrimFig network ads (Mandatory for AdStation access). NEVER serves direct deals.
 *   direct        -> Website owner's direct client ads (100% revenue to site owner; 0% CrimFig commission).
 *   network       -> Extra monetized website ad slots on the domain (55% publisher / 30% CF / 15% dynamic pool).
 *   hybrid        -> Co-existence slot allocated via account delivery preference (High/Medium/Low).
 */
export const adstationSlotTypeEnum = pgEnum('adstation_slot_type', [
  'consideration',
  'direct',
  'network',
  'hybrid',
]);

export const adstationDirectCampaignStatusEnum = pgEnum('adstation_direct_campaign_status', [
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
]);

/**
 * adstation_slots
 *
 * Configured ad units on verified promoter websites for AdStation direct & consideration delivery.
 */
export const adstationSlots = pgTable(
  'adstation_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    websiteId: uuid('website_id')
      .notNull()
      .references(() => adsPromoterWebsites.id, { onDelete: 'cascade' }),
    promoterId: uuid('promoter_id')
      .notNull()
      .references(() => adsPromoters.id, { onDelete: 'cascade' }),

    name: varchar('name', { length: 150 }).notNull(),
    slotType: adstationSlotTypeEnum('slot_type').notNull().default('direct'),
    format: varchar('format', { length: 50 }).notNull().default('banner'), // banner, card, video, interstitial

    // Consideration Slot Verification & Exclusivity (PLAN-0018 Section 2.1)
    isConsiderationSlot: boolean('is_consideration_slot').notNull().default(false),
    isConsiderationVerified: boolean('is_consideration_verified').notNull().default(false),
    considerationLastCheckedAt: timestamp('consideration_last_checked_at', { withTimezone: true }),

    // Slot-level delivery preference override (null uses website.deliveryPreference)
    slotDeliveryPreference: varchar('slot_delivery_preference', { length: 20 }),

    // HTML / Embed identifier
    slotTagId: varchar('slot_tag_id', { length: 64 }).notNull().unique(),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('adstation_slots_website_id_idx').on(t.websiteId),
    index('adstation_slots_promoter_id_idx').on(t.promoterId),
    index('adstation_slots_slot_type_idx').on(t.slotType),
    index('adstation_slots_tag_id_idx').on(t.slotTagId),
  ],
);

/**
 * adstation_direct_campaigns
 *
 * Direct advertiser arrangements managed by website owners.
 * 100% of revenue goes to the website owner; 0% CrimFig platform cut.
 * Completely isolated from CrimFig network billing and dynamic pool.
 */
export const adstationDirectCampaigns = pgTable(
  'adstation_direct_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoterId: uuid('promoter_id')
      .notNull()
      .references(() => adsPromoters.id, { onDelete: 'cascade' }),
    websiteId: uuid('website_id')
      .notNull()
      .references(() => adsPromoterWebsites.id, { onDelete: 'cascade' }),
    slotId: uuid('slot_id')
      .references(() => adstationSlots.id, { onDelete: 'set null' }),

    clientName: varchar('client_name', { length: 150 }).notNull(),
    campaignTitle: varchar('campaign_title', { length: 255 }).notNull(),
    destinationUrl: text('destination_url').notNull(),
    headline: text('headline'),
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),

    // Goal and target constraints
    targetImpressions: bigint('target_impressions', { mode: 'number' }).notNull().default(0),
    deliveredImpressions: bigint('delivered_impressions', { mode: 'number' }).notNull().default(0),
    deliveredClicks: bigint('delivered_clicks', { mode: 'number' }).notNull().default(0),

    // Status
    status: adstationDirectCampaignStatusEnum('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('adstation_direct_campaigns_promoter_id_idx').on(t.promoterId),
    index('adstation_direct_campaigns_website_id_idx').on(t.websiteId),
    index('adstation_direct_campaigns_slot_id_idx').on(t.slotId),
    index('adstation_direct_campaigns_status_idx').on(t.status),
  ],
);

export type AdstationSlot = typeof adstationSlots.$inferSelect;
export type NewAdstationSlot = typeof adstationSlots.$inferInsert;
export type AdstationDirectCampaign = typeof adstationDirectCampaigns.$inferSelect;
export type NewAdstationDirectCampaign = typeof adstationDirectCampaigns.$inferInsert;
