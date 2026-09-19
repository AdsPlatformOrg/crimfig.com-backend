import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { adsCampaigns } from './ads_campaigns';

/**
 * ads_creatives
 *
 * Creative assets attached to a campaign.
 * One campaign can have multiple creatives (A/B testing, different formats).
 *
 * destination_url: Where the user lands when they click the ad.
 * image_url: CDN URL of the ad image/video asset.
 *
 * Note: The Reels integration fetches creatives via
 *   GET /api/v1/ads/creative/:creativeId
 * using the crid parameter in the promoter share link.
 */
export const creativeStatusEnum = pgEnum('ads_creative_status', [
  'active',
  'paused',
  'archived',
]);

export const adsCreatives = pgTable(
  'ads_creatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'cascade' }),

    // Ad copy
    headline: varchar('headline', { length: 100 }).notNull(),
    bodyText: text('body_text'),
    ctaText: varchar('cta_text', { length: 50 }).notNull().default('Learn More'),

    // Asset URLs
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),

    // Where clicking the ad goes
    destinationUrl: text('destination_url').notNull(),

    status: creativeStatusEnum('status').notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_creatives_campaign_id_idx').on(t.campaignId),
    index('ads_creatives_status_idx').on(t.status),
  ],
);

export type AdsCreative = typeof adsCreatives.$inferSelect;
export type NewAdsCreative = typeof adsCreatives.$inferInsert;
