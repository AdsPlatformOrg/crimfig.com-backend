-- Migration 0029_ads_house_creatives.sql
-- Creates ads_house_creatives table and seeds primary image house ad and fallback text house ad.

CREATE TABLE IF NOT EXISTS "ads_house_creatives" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "title" VARCHAR(255) NOT NULL,
    "headline" VARCHAR(255) NOT NULL,
    "body_text" TEXT NOT NULL,
    "cta_text" VARCHAR(64) NOT NULL DEFAULT 'Start Advertising',
    "destination_url" TEXT NOT NULL DEFAULT 'https://ads.crimfig.com',
    "ad_type" VARCHAR(32) NOT NULL DEFAULT 'image',
    "format" VARCHAR(64) NOT NULL DEFAULT 'banner',
    "image_url" TEXT,
    "video_url" TEXT,
    "poster_url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ads_house_creatives_priority" ON "ads_house_creatives" ("priority", "is_active");
CREATE INDEX IF NOT EXISTS "idx_ads_house_creatives_ad_type" ON "ads_house_creatives" ("ad_type", "is_active");

-- Seed Primary Image House Ad (Priority 100)
INSERT INTO "ads_house_creatives" (
    "id",
    "title",
    "headline",
    "body_text",
    "cta_text",
    "destination_url",
    "ad_type",
    "format",
    "image_url",
    "width",
    "height",
    "priority",
    "is_active"
) VALUES (
    '00000000-0000-4000-8000-00000000cf02',
    'Advertise with CrimFig (Hero Image)',
    'Advertise with CrimFig',
    'Reach real people. Grow your business.',
    'Start Advertising',
    'https://ads.crimfig.com',
    'image',
    'banner',
    'https://media.crimfig.com/house-ads/crimfig-advertise-hero-1024x682.jpg',
    1024,
    682,
    100,
    true
) ON CONFLICT ("id") DO UPDATE SET
    "image_url" = EXCLUDED."image_url",
    "destination_url" = EXCLUDED."destination_url",
    "headline" = EXCLUDED."headline",
    "body_text" = EXCLUDED."body_text",
    "ad_type" = EXCLUDED."ad_type",
    "priority" = EXCLUDED."priority",
    "is_active" = EXCLUDED."is_active";

-- Seed Fallback Text House Ad (Priority 10)
INSERT INTO "ads_house_creatives" (
    "id",
    "title",
    "headline",
    "body_text",
    "cta_text",
    "destination_url",
    "ad_type",
    "format",
    "image_url",
    "priority",
    "is_active"
) VALUES (
    '00000000-0000-4000-8000-00000000cf04',
    'Advertise with CrimFig (Text Fallback)',
    'Advertise with CrimFig',
    'Reach real people and scale your business with transparent escrow protection.',
    'Start Advertising',
    'https://ads.crimfig.com',
    'text',
    'banner',
    NULL,
    10,
    true
) ON CONFLICT ("id") DO UPDATE SET
    "destination_url" = EXCLUDED."destination_url",
    "headline" = EXCLUDED."headline",
    "body_text" = EXCLUDED."body_text",
    "ad_type" = EXCLUDED."ad_type",
    "priority" = EXCLUDED."priority",
    "is_active" = EXCLUDED."is_active";

