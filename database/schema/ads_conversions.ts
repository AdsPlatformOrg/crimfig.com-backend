import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  numeric,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { adsCampaigns } from './ads_campaigns';
import { adsPromoters } from './ads_promoters';

/**
 * ads_clicks
 *
 * Indexed record of every outbound ad click.
 * Stores a cryptographically verifiable click_id (cf_click) propagated to the landing page
 * to correlate subsequent conversion postbacks.
 */
export const adsClicks = pgTable(
  'ads_clicks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clickId: varchar('click_id', { length: 64 }).notNull().unique(), // e.g. clk_20261017_abcd1234efgh5678
    serveId: uuid('serve_id'),
    interactionId: uuid('interaction_id'),
    campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'cascade' }),
    promoterId: uuid('promoter_id').references(() => adsPromoters.id, { onDelete: 'set null' }),

    actorIp: varchar('actor_ip', { length: 45 }),
    userAgent: text('user_agent'),

    clickedAt: timestamp('clicked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // standard 30-day attribution validity
  },
  (t) => [
    index('ads_clicks_click_id_idx').on(t.clickId),
    index('ads_clicks_campaign_id_idx').on(t.campaignId),
    index('ads_clicks_promoter_id_idx').on(t.promoterId),
    index('ads_clicks_clicked_at_idx').on(t.clickedAt),
  ],
);

export type AdsClick = typeof adsClicks.$inferSelect;
export type NewAdsClick = typeof adsClicks.$inferInsert;

/**
 * ads_conversion_status
 */
export const conversionStatusEnum = pgEnum('ads_conversion_status', [
  'attributed',
  'unattributed',
  'duplicate',
  'reversed',
  'disputed',
]);

/**
 * ads_conversion_source
 */
export const conversionSourceEnum = pgEnum('ads_conversion_source', [
  'pixel',
  's2s',
]);

/**
 * ads_conversions
 *
 * First-class append-only ledger for all attributed and unattributed conversion events
 * reported via browser pixel (<script src="px.js">) or Server-to-Server (S2S) postback.
 */
export const adsConversions = pgTable(
  'ads_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => adsCampaigns.id, { onDelete: 'set null' }),
    clickId: varchar('click_id', { length: 64 }), // correlates to ads_clicks.click_id

    event: varchar('event', { length: 50 }).notNull(), // 'purchase' | 'lead' | 'sign_up' | 'add_to_cart' | 'app_install' | 'custom'
    orderId: varchar('order_id', { length: 128 }), // deduplication key per advertiser

    // Monetary conversions (e.g. e-commerce purchase value)
    valueMicros: bigint('value_micros', { mode: 'number' }),
    currency: varchar('currency', { length: 10 }).default('USD'),
    valueUsdMicros: bigint('value_usd_micros', { mode: 'number' }),
    fxRateSnapshot: numeric('fx_rate_snapshot', { precision: 12, scale: 4 }),

    source: conversionSourceEnum('source').notNull().default('s2s'),
    status: conversionStatusEnum('status').notNull().default('attributed'),

    attributedPromoterId: uuid('attributed_promoter_id').references(() => adsPromoters.id, { onDelete: 'set null' }),
    chargedMicros: bigint('charged_micros', { mode: 'number' }).default(0),

    // 72-Hour Clearance Hold for CPA promoter earnings
    holdbackReleaseAt: timestamp('holdback_release_at', { withTimezone: true }),
    settlementBatchId: varchar('settlement_batch_id', { length: 50 }),

    // Metadata payload (products, category, S2S client info)
    metadata: text('metadata'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_conversions_advertiser_id_idx').on(t.advertiserId),
    index('ads_conversions_campaign_id_idx').on(t.campaignId),
    index('ads_conversions_click_id_idx').on(t.clickId),
    index('ads_conversions_status_idx').on(t.status),
    index('ads_conversions_occurred_at_idx').on(t.occurredAt),
    // Deduplication constraint: (advertiser_id, order_id, event)
    uniqueIndex('ads_conversions_dedupe_idx').on(t.advertiserId, t.orderId, t.event),
  ],
);

export type AdsConversion = typeof adsConversions.$inferSelect;
export type NewAdsConversion = typeof adsConversions.$inferInsert;

/**
 * ads_advertiser_api_keys
 *
 * Scoped API keys for advertisers to report conversions securely via S2S postbacks.
 * Secret keys are hashed with SHA-256 / argon2 at rest and shown only once upon creation.
 */
export const adsAdvertiserApiKeys = pgTable(
  'ads_advertiser_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advertiserId: uuid('advertiser_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(), // e.g. "Shopify Production Store"
    prefix: varchar('prefix', { length: 16 }).notNull(), // e.g. "cf_adv_live_abc1"
    keyHash: text('key_hash').notNull().unique(), // argon2 / SHA-256 hash of secret key
    scopes: text('scopes').notNull().default('conversions:write'), // comma-separated e.g. "conversions:write,reports:read"

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_advertiser_api_keys_advertiser_idx').on(t.advertiserId),
    index('ads_advertiser_api_keys_prefix_idx').on(t.prefix),
  ],
);

export type AdsAdvertiserApiKey = typeof adsAdvertiserApiKeys.$inferSelect;
export type NewAdsAdvertiserApiKey = typeof adsAdvertiserApiKeys.$inferInsert;
