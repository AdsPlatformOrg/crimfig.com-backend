import { pgTable, uuid, varchar, text, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { adsPlacements, adsPromoters } from './ads_promoters';

/**
 * ads_interactions
 *
 * APPEND-ONLY immutable event log for all ad interactions.
 * Never updated or deleted — every event is a new row.
 *
 * Events:
 *   impression    → ad was displayed (from embed.js or share link view)
 *   click         → user clicked the ad
 *   hover         → user hovered over ad container (desktop engagement metric)
 *   touch         → user touched/interacted with ad container (mobile gesture metric)
 *   share         → promoter shared the link on social media
 *   reels_view    → ad was viewed via Crimfig Reels (ref=reels)
 *   embed_ping    → embed.js fired on page load (verifies site is active)
 *   conversion    → user completed a desired action after clicking (future)
 *
 * actor_ip is stored for fraud detection (rate limiting per IP).
 * Never exposed in public-facing APIs — internal use only.
 */
export const interactionTypeEnum = pgEnum('ads_interaction_type', [
  'impression',
  'viewable_impression',
  'click',
  'hover',
  'touch',
  'share',
  'reels_view',
  'video_q25',
  'video_q50',
  'video_q75',
  'video_complete',
  'embed_ping',
  'conversion',
]);

export const adsInteractions = pgTable(
  'ads_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placementId: uuid('placement_id').notNull().references(() => adsPlacements.id, { onDelete: 'restrict' }),
    promoterId: uuid('promoter_id').notNull().references(() => adsPromoters.id, { onDelete: 'restrict' }),

    // Optional link to initial auction resolution serve record
    serveId: uuid('serve_id'),

    type: interactionTypeEnum('type').notNull(),

    // Anti-Fraud & Quality Verification Flags
    verificationVersion: integer('verification_version').notNull().default(0),
    isValid: boolean('is_valid').notNull().default(true),
    invalidReason: varchar('invalid_reason', { length: 50 }),

    // Source of the interaction (embed | share_link | reels | direct)
    source: varchar('source', { length: 30 }),

    // For fraud detection — never exposed via API
    actorIp: varchar('actor_ip', { length: 45 }),
    userAgent: text('user_agent'),

    // Referrer URL (where the click came from)
    referrer: text('referrer'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_interactions_placement_id_idx').on(t.placementId),
    index('ads_interactions_promoter_id_idx').on(t.promoterId),
    index('ads_interactions_serve_id_idx').on(t.serveId),
    index('ads_interactions_is_valid_idx').on(t.isValid),
    index('ads_interactions_type_idx').on(t.type),
    index('ads_interactions_created_at_idx').on(t.createdAt),
  ],
);

/**
 * ads_promoter_earnings
 *
 * Earnings ledger for promoters. Each tracked impression/click creates a row.
 * Amounts in USD cents.
 *
 * After creation, the billing Internal Ecosystem API is called to
 * credit the promoter's billing_wallet.
 */
export const adsPromoterEarnings = pgTable(
  'ads_promoter_earnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoterId: uuid('promoter_id').notNull().references(() => adsPromoters.id, { onDelete: 'restrict' }),
    placementId: uuid('placement_id').notNull().references(() => adsPlacements.id, { onDelete: 'restrict' }),
    interactionId: uuid('interaction_id').notNull().references(() => adsInteractions.id, { onDelete: 'restrict' }),

    interactionType: interactionTypeEnum('interaction_type').notNull(),

    // Amount earned for this single interaction (USD cents)
    amountUsdCents: integer('amount_usd_cents').notNull(),

    // Billing transaction ID created when wallet was credited
    billingTransactionId: uuid('billing_transaction_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_promoter_earnings_promoter_id_idx').on(t.promoterId),
    index('ads_promoter_earnings_created_at_idx').on(t.createdAt),
  ],
);

/**
 * ads_reels_consents
 *
 * Records whether an INDIVIDUAL promoter has consented to having
 * their campaign share links automatically posted to their Crimfig Reels page.
 *
 * This table is referenced when Reels launches. For now, the promoter
 * manually copies the share link. The consent flag determines whether
 * Reels auto-posts on their behalf when they apply to future campaigns.
 */
export const adsReelsConsents = pgTable(
  'ads_reels_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promoterId: uuid('promoter_id').notNull().unique().references(() => adsPromoters.id, { onDelete: 'cascade' }),

    // true = consented to Reels auto-sharing new placements
    consentGiven: integer('consent_given').notNull().default(0), // 0=no, 1=yes
    consentGivenAt: timestamp('consent_given_at', { withTimezone: true }),
    consentRevokedAt: timestamp('consent_revoked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export type AdsInteraction = typeof adsInteractions.$inferSelect;
export type NewAdsInteraction = typeof adsInteractions.$inferInsert;
export type AdsPromoterEarning = typeof adsPromoterEarnings.$inferSelect;
export type NewAdsPromoterEarning = typeof adsPromoterEarnings.$inferInsert;
export type AdsReelsConsent = typeof adsReelsConsents.$inferSelect;
export type NewAdsReelsConsent = typeof adsReelsConsents.$inferInsert;

/**
 * ads_embed_run_audits
 *
 * APPEND-ONLY immutable execution audit log.
 * Logged each time embed.js or mobile SDK executes on a partner site/app.
 * Used by the scheduled background cron job (every 30m - 1h) to verify
 * partner domains/apps and detect fraudulent or spoofed traffic asynchronously.
 */
export const adsEmbedRunAudits = pgTable(
  'ads_embed_run_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    placementId: uuid('placement_id').references(() => adsPlacements.id, { onDelete: 'set null' }),
    promoterId: uuid('promoter_id').references(() => adsPromoters.id, { onDelete: 'set null' }),
    websiteId: uuid('website_id'),
    appId: uuid('app_id'),
    domain: varchar('domain', { length: 255 }),
    bundleId: varchar('bundle_id', { length: 255 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    referrer: text('referrer'),
    runTimestamp: timestamp('run_timestamp', { withTimezone: true }).notNull().defaultNow(),
    isProcessed: boolean('is_processed').notNull().default(false),
    auditFlags: text('audit_flags'), // JSON flags e.g. domain_mismatch, rate_limit_flag
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_embed_run_audits_promoter_id_idx').on(t.promoterId),
    index('ads_embed_run_audits_domain_idx').on(t.domain),
    index('ads_embed_run_audits_is_processed_idx').on(t.isProcessed),
    index('ads_embed_run_audits_created_at_idx').on(t.createdAt),
  ],
);

export type AdsEmbedRunAudit = typeof adsEmbedRunAudits.$inferSelect;
export type NewAdsEmbedRunAudit = typeof adsEmbedRunAudits.$inferInsert;
