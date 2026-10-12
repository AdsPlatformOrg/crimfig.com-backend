CREATE TYPE "public"."ads_asset_review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ads_creative_media_format" AS ENUM('image', 'gif', 'video');--> statement-breakpoint
ALTER TYPE "public"."ads_campaign_status" ADD VALUE 'under_review' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."ads_campaign_status" ADD VALUE 'rejected' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."ads_campaign_status" ADD VALUE 'suspended' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."ads_campaign_status" ADD VALUE 'trash' BEFORE 'completed';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'hover' BEFORE 'share';--> statement-breakpoint
ALTER TYPE "public"."ads_interaction_type" ADD VALUE 'touch' BEFORE 'share';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_embed_run_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placement_id" uuid,
	"promoter_id" uuid,
	"website_id" uuid,
	"app_id" uuid,
	"domain" varchar(255),
	"bundle_id" varchar(255),
	"ip_address" varchar(45),
	"user_agent" text,
	"referrer" text,
	"run_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"is_processed" boolean DEFAULT false NOT NULL,
	"audit_flags" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_user_table_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"table_name" varchar(64) DEFAULT 'campaigns_performance' NOT NULL,
	"columns_config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_user_table_prefs_user_table_uniq" UNIQUE("user_id","table_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_metrics_hourly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"creative_id" uuid,
	"promoter_id" uuid,
	"placement_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"impressions_count" integer DEFAULT 0 NOT NULL,
	"clicks_count" integer DEFAULT 0 NOT NULL,
	"hovers_count" integer DEFAULT 0 NOT NULL,
	"touches_count" integer DEFAULT 0 NOT NULL,
	"spend_usd_cents" integer DEFAULT 0 NOT NULL,
	"earnings_usd_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_metrics_hourly_rollup_uniq" UNIQUE("campaign_id","creative_id","placement_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "daily_budget_usd_cents" integer;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "media_format" "ads_creative_media_format" DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "review_status" "ads_asset_review_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "ads_creatives" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads_promoter_apps" ADD COLUMN "allowed_categories" text;--> statement-breakpoint
ALTER TABLE "ads_promoter_websites" ADD COLUMN "allowed_categories" text;--> statement-breakpoint
ALTER TABLE "ads_promoters" ADD COLUMN "allowed_categories" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_embed_run_audits" ADD CONSTRAINT "ads_embed_run_audits_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_embed_run_audits" ADD CONSTRAINT "ads_embed_run_audits_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_user_table_preferences" ADD CONSTRAINT "ads_user_table_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_metrics_hourly" ADD CONSTRAINT "ads_metrics_hourly_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_metrics_hourly" ADD CONSTRAINT "ads_metrics_hourly_creative_id_ads_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ads_creatives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_metrics_hourly" ADD CONSTRAINT "ads_metrics_hourly_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_metrics_hourly" ADD CONSTRAINT "ads_metrics_hourly_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_embed_run_audits_promoter_id_idx" ON "ads_embed_run_audits" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_embed_run_audits_domain_idx" ON "ads_embed_run_audits" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_embed_run_audits_is_processed_idx" ON "ads_embed_run_audits" USING btree ("is_processed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_embed_run_audits_created_at_idx" ON "ads_embed_run_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_user_table_prefs_user_id_idx" ON "ads_user_table_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_metrics_hourly_campaign_id_idx" ON "ads_metrics_hourly" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_metrics_hourly_promoter_id_idx" ON "ads_metrics_hourly" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_metrics_hourly_period_start_idx" ON "ads_metrics_hourly" USING btree ("period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_creatives_review_status_idx" ON "ads_creatives" USING btree ("review_status");