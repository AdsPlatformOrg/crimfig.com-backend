import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { adsCampaigns, adFormatEnum } from './ads_campaigns';
import { adsCreativeStacks } from './ads_creative_stacks';

/**
 * ads_creatives
 *
 * Creative assets attached to a campaign.
 * One campaign can have multiple creatives (A/B testing, different formats).
 *
 * destination_url: Where the user lands when they click the ad.
 * image_url: CDN URL of the ad image/video asset.
 *
 * Delivery selects individual creatives through ads_placements and ads_serves.
 * There is no standalone public creative endpoint.
 */
export const creativeStatusEnum = pgEnum('ads_creative_status', [
  'active',
  'paused',
  'archived',
]);

export const assetReviewStatusEnum = pgEnum('ads_asset_review_status', [
  'pending',
  'approved',
  'rejected',
]);

export const creativeMediaFormatEnum = pgEnum('ads_creative_media_format', [
  'image',
  'gif',
  'video',
]);

/**
 * Explicit ad content type. This is deliberately separate from `adFormat`
 * (placement/render format) and `mediaFormat` (encoded asset kind).
 */
export const creativeAdTypeEnum = pgEnum('ads_creative_ad_type', [
  'text',
  'image',
  'video',
]);

export const adsCreatives = pgTable(
  'ads_creatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'cascade' }),
    adStackId: uuid('ad_stack_id').notNull().references(() => adsCreativeStacks.id, { onDelete: 'restrict' }),
    adType: creativeAdTypeEnum('ad_type').notNull().default('text'),

    // Ad copy
    headline: varchar('headline', { length: 100 }).notNull(),
    bodyText: text('body_text'),
    ctaText: varchar('cta_text', { length: 50 }).notNull().default('Learn More'),

    // Asset URLs and format (Images, GIFs, Videos)
    mediaFormat: creativeMediaFormatEnum('media_format').notNull().default('image'),
    adFormat: adFormatEnum('ad_format').notNull().default('card'),
    mediaAssetId: uuid('media_asset_id'),
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),
    posterUrl: text('poster_url'),

    width: integer('width'),
    height: integer('height'),

    // Where clicking the ad goes
    destinationUrl: text('destination_url').notNull(),

    // Operational and Asset-Level Moderation Status
    status: creativeStatusEnum('status').notNull().default('active'),
    reviewStatus: assetReviewStatusEnum('review_status').notNull().default('pending'),
    rejectionReason: text('rejection_reason'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_creatives_campaign_id_idx').on(t.campaignId),
    index('ads_creatives_stack_id_idx').on(t.adStackId),
    index('ads_creatives_status_idx').on(t.status),
    index('ads_creatives_review_status_idx').on(t.reviewStatus),
  ],
);

export type AdsCreative = typeof adsCreatives.$inferSelect;
export type NewAdsCreative = typeof adsCreatives.$inferInsert;
