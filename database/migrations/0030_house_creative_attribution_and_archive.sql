-- Migration 0030: Add house creative attribution and archiving fields (PLAN-0061)

ALTER TABLE "ads_house_creatives" 
  ADD COLUMN IF NOT EXISTS "is_archived" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_ads_house_creatives_active_priority" 
  ON "ads_house_creatives" ("priority", "is_active", "is_archived");

ALTER TABLE "ads_serves"
  ADD COLUMN IF NOT EXISTS "house_creative_id" uuid,
  ADD COLUMN IF NOT EXISTS "house_creative_version" integer;

CREATE INDEX IF NOT EXISTS "idx_ads_serves_house_creative_id"
  ON "ads_serves" ("house_creative_id") WHERE "house_creative_id" IS NOT NULL;

