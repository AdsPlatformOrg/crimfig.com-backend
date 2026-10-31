import {adsMediaAssets} from './ads_serves_and_assets';
import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * ads_house_creatives
 *
 * Dedicated database table for CrimFig House Ads.
 * Allows Platform Admins to configure, upload, prioritize, and manage house ads
 * that serve during promoter testing mode, unmonetized traffic, or auction no-fill.
 */
export const adsHouseCreatives = pgTable(
  'ads_house_creatives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    headline: varchar('headline', { length: 255 }).notNull(),
    bodyText: text('body_text').notNull(),
    ctaText: varchar('cta_text', { length: 64 }).notNull().default('Start Advertising'),
    destinationUrl: text('destination_url').notNull().default('https://ads.crimfig.com'),
    adType: varchar('ad_type', { length: 32 }).notNull().default('image'), // 'image' | 'text' | 'video'
    format: varchar('format', { length: 64 }).notNull().default('banner'), // 'banner' | 'square' | 'interstitial' | 'any'
    imageAssetId: uuid('image_asset_id').references(()=>adsMediaAssets.id,{onDelete:'restrict'}),
    videoAssetId: uuid('video_asset_id').references(()=>adsMediaAssets.id,{onDelete:'restrict'}),
    imageUrl: text('image_url'),
    videoUrl: text('video_url'),
    posterUrl: text('poster_url'),
    width: integer('width'),
    height: integer('height'),
    priority: integer('priority').notNull().default(10), // Higher priority evaluated first
    isActive: boolean('is_active').notNull().default(true),
    isArchived: boolean('is_archived').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    priorityIdx: index('idx_ads_house_creatives_priority').on(table.priority, table.isActive, table.isArchived),
    adTypeIdx: index('idx_ads_house_creatives_ad_type').on(table.adType, table.isActive, table.isArchived),
  }),
);

