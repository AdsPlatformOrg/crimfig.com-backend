import {
  jsonb,
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  smallint,
  boolean,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { adsCampaigns } from "./ads_campaigns";
import { adsCreatives } from "./ads_creatives";
import { adsPlacements, adsPromoters } from "./ads_promoters";

/**
 * ads_media_assets
 *
 * Direct S3 / Cloudflare R2 uploaded creative media assets.
 * Content-addressed storage key ensures immutability.
 */
export const mediaAssetStatusEnum = pgEnum("ads_media_asset_status", [
  "pending",
  "ready",
  "rejected",
  "deleted",
]);

export const adsMediaAssets = pgTable(
  "ads_media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    storageKey: varchar("storage_key", { length: 500 }).notNull().unique(),
    cdnUrl: text("cdn_url").notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),

    preparation: jsonb("preparation"),
    width: smallint("width"),
    height: smallint("height"),
    durationSeconds: smallint("duration_seconds"),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    thumbnailUrl: text("thumbnail_url"),

    status: mediaAssetStatusEnum("status").notNull().default("pending"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ads_media_assets_owner_id_idx").on(t.ownerId),
    index("ads_media_assets_sha256_idx").on(t.sha256),
    index("ads_media_assets_status_idx").on(t.status),
  ],
);

export type AdsMediaAsset = typeof adsMediaAssets.$inferSelect;
export type NewAdsMediaAsset = typeof adsMediaAssets.$inferInsert;

/**
 * ads_serves
 *
 * Append-only immutable log of every auction resolution and ad delivery impression token issued.
 * Zero money deduction occurs at serve time.
 */
export const adsServes = pgTable(
  "ads_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    placementId: uuid("placement_id").references(() => adsPlacements.id, {
      onDelete: "set null",
    }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => adsCampaigns.id, { onDelete: "restrict" }),
    creativeId: uuid("creative_id")
      .notNull()
      .references(() => adsCreatives.id, { onDelete: "restrict" }),
    promoterId: uuid("promoter_id").references(() => adsPromoters.id, {
      onDelete: "set null",
    }),

    slotHandle: varchar("slot_handle", { length: 50 }).notNull(),
    // Clearing price in micros (1/1,000,000 USD) for high-precision second-price auction resolution
    pricingVersion: smallint("pricing_version").notNull().default(1),
    // Immutable exact price per eligible event; never derive money from the eCPM score.
    billingPriceNanos: bigint("billing_price_nanos", { mode: "bigint" })
      .notNull()
      .default(0n),
    clearingPriceMicros: bigint("clearing_price_micros", { mode: "number" })
      .notNull()
      .default(0),
    pricingModel: varchar("pricing_model", { length: 20 })
      .notNull()
      .default("cpm"),

    // Anonymized/hashed client identifiers for fraud prevention
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgentHash: varchar("ua_hash", { length: 64 }),

    geoCountry: varchar("geo_country", { length: 2 }),
    geoRegion: varchar("geo_region", { length: 50 }),
    deviceType: varchar("device_type", { length: 20 }),

    // PLAN-0047 / PLAN-0049: Supply admission, delivery mode, financial eligibility & decision links
    requestId: uuid("request_id"),
    websiteId: uuid("website_id"),
    slotId: uuid("slot_id"),
    // 'house' | 'shadow' | 'direct' | 'paid' | 'simulated_paid'
    inventoryClass: varchar("inventory_class", { length: 24 })
      .notNull()
      .default("paid"),
    // 'normal' | 'shadow' | 'no_fill'
    deliveryMode: varchar("delivery_mode", { length: 20 })
      .notNull()
      .default("normal"),
    // 'normal' | 'suspicious' | 'high_risk' | 'confirmed_fraud'
    trafficRiskStatus: varchar("traffic_risk_status", { length: 24 })
      .notNull()
      .default("normal"),
    // 'pending' | 'eligible' | 'quarantined' | 'invalid'
    financialEligibility: varchar("financial_eligibility", { length: 24 })
      .notNull()
      .default("pending"),
    auctionDecisionId: uuid("auction_decision_id"),
    opportunityReservationId: uuid("opportunity_reservation_id"),
    policyVersion: varchar("policy_version", { length: 32 })
      .notNull()
      .default("auction_v1"),

    servedAt: timestamp("served_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ads_serves_campaign_id_idx").on(t.campaignId),
    index("ads_serves_placement_id_idx").on(t.placementId),
    index("ads_serves_promoter_id_idx").on(t.promoterId),
    index("ads_serves_served_at_idx").on(t.servedAt),
  ],
);

export type AdsServe = typeof adsServes.$inferSelect;
export type NewAdsServe = typeof adsServes.$inferInsert;

/**
 * ads_moderation_decisions
 *
 * Audit ledger recording every compliance review decision made on campaigns or creative assets.
 */
export const moderationTargetTypeEnum = pgEnum("ads_moderation_target_type", [
  "campaign",
  "creative",
]);

export const moderationDecisionEnum = pgEnum("ads_moderation_decision", [
  "approved",
  "rejected",
  "suspended",
]);

export const adsModerationDecisions = pgTable(
  "ads_moderation_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: moderationTargetTypeEnum("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    submissionId: uuid('submission_id'),
    contentRevision: bigint('content_revision', { mode: 'number' }),
    stage: varchar('stage', { length: 30 }),
    requestId: uuid('request_id'),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    decision: moderationDecisionEnum("decision").notNull(),
    reasonCode: varchar("reason_code", { length: 50 }),
    note: text("note"),

    // Super Admin Emergency Override tracking
    isEmergencyOverride: boolean("is_emergency_override")
      .notNull()
      .default(false),
    overrideReason: text("override_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ads_moderation_target_idx").on(t.targetType, t.targetId),
    index("ads_moderation_reviewer_idx").on(t.reviewerId),
    index("ads_moderation_created_at_idx").on(t.createdAt),
  ],
);

export type AdsModerationDecision = typeof adsModerationDecisions.$inferSelect;
export type NewAdsModerationDecision =
  typeof adsModerationDecisions.$inferInsert;
