CREATE TYPE "public"."ads_media_asset_status" AS ENUM('pending', 'ready', 'rejected', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."ads_moderation_decision" AS ENUM('approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."ads_moderation_target_type" AS ENUM('campaign', 'creative');--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'viewable_impression' BEFORE 'click';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'video_q25' BEFORE 'embed_ping';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'video_q50' BEFORE 'embed_ping';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'video_q75' BEFORE 'embed_ping';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'video_complete' BEFORE 'embed_ping';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_key" varchar(500) NOT NULL,
	"cdn_url" text NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"bytes" bigint NOT NULL,
	"width" smallint,
	"height" smallint,
	"duration_seconds" smallint,
	"sha256" varchar(64) NOT NULL,
	"thumbnail_url" text,
	"status" "ads_media_asset_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_media_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_moderation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "ads_moderation_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" "ads_moderation_decision" NOT NULL,
	"reason_code" varchar(50),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_serves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placement_id" uuid,
	"campaign_id" uuid NOT NULL,
	"creative_id" uuid NOT NULL,
	"promoter_id" uuid,
	"slot_handle" varchar(50) NOT NULL,
	"clearing_price_micros" bigint DEFAULT 0 NOT NULL,
	"pricing_model" varchar(20) DEFAULT 'cpm' NOT NULL,
	"ip_hash" varchar(64),
	"ua_hash" varchar(64),
	"geo_country" varchar(2),
	"geo_region" varchar(50),
	"device_type" varchar(20),
	"served_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads_campaigns" ALTER COLUMN "budget_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ALTER COLUMN "daily_budget_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ALTER COLUMN "remaining_budget_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ALTER COLUMN "cost_per_impression_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ALTER COLUMN "cost_per_click_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "hourly_pacing_usd_cents" bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "pricing_model" varchar(20) DEFAULT 'cpm' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "target_countries" text;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "target_states" text;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "target_devices" text;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "target_hours" text;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "frequency_cap_per_day" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "media_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "ads_promoter_websites" ADD COLUMN "trust_score" smallint DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoter_websites" ADD COLUMN "is_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoter_websites" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "ads_promoter_websites" ADD COLUMN "verification_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoters" ADD COLUMN "trust_score" smallint DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoters" ADD COLUMN "is_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoters" ADD COLUMN "suspension_reason" text;--> statement-breakpoint
ALTER TABLE "ads_interactions" ADD COLUMN "serve_id" uuid;--> statement-breakpoint
ALTER TABLE "ads_interactions" ADD COLUMN "is_valid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_interactions" ADD COLUMN "invalid_reason" varchar(50);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_media_assets" ADD CONSTRAINT "ads_media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_moderation_decisions" ADD CONSTRAINT "ads_moderation_decisions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_serves" ADD CONSTRAINT "ads_serves_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_serves" ADD CONSTRAINT "ads_serves_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_serves" ADD CONSTRAINT "ads_serves_creative_id_ads_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ads_creatives"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_serves" ADD CONSTRAINT "ads_serves_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_media_assets_owner_id_idx" ON "ads_media_assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_media_assets_sha256_idx" ON "ads_media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_media_assets_status_idx" ON "ads_media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_moderation_target_idx" ON "ads_moderation_decisions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_moderation_reviewer_idx" ON "ads_moderation_decisions" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_moderation_created_at_idx" ON "ads_moderation_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_serves_campaign_id_idx" ON "ads_serves" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_serves_placement_id_idx" ON "ads_serves" USING btree ("placement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_serves_promoter_id_idx" ON "ads_serves" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_serves_served_at_idx" ON "ads_serves" USING btree ("served_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_websites_trust_score_idx" ON "ads_promoter_websites" USING btree ("trust_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoters_trust_score_idx" ON "ads_promoters" USING btree ("trust_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_serve_id_idx" ON "ads_interactions" USING btree ("serve_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_interactions_is_valid_idx" ON "ads_interactions" USING btree ("is_valid");