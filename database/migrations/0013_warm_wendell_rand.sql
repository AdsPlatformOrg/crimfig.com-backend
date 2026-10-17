CREATE TYPE "public"."ads_conversion_source" AS ENUM('pixel', 's2s');--> statement-breakpoint
CREATE TYPE "public"."ads_conversion_status" AS ENUM('attributed', 'unattributed', 'duplicate', 'reversed', 'disputed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_advertiser_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text DEFAULT 'conversions:write' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ads_advertiser_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"click_id" varchar(64) NOT NULL,
	"serve_id" uuid,
	"interaction_id" uuid,
	"campaign_id" uuid NOT NULL,
	"promoter_id" uuid,
	"actor_ip" varchar(45),
	"user_agent" text,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ads_clicks_click_id_unique" UNIQUE("click_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"campaign_id" uuid,
	"click_id" varchar(64),
	"event" varchar(50) NOT NULL,
	"order_id" varchar(128),
	"value_micros" bigint,
	"currency" varchar(10) DEFAULT 'USD',
	"value_usd_micros" bigint,
	"fx_rate_snapshot" numeric(12, 4),
	"source" "ads_conversion_source" DEFAULT 's2s' NOT NULL,
	"status" "ads_conversion_status" DEFAULT 'attributed' NOT NULL,
	"attributed_promoter_id" uuid,
	"charged_micros" bigint DEFAULT 0,
	"holdback_release_at" timestamp with time zone,
	"settlement_batch_id" varchar(50),
	"metadata" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_advertiser_api_keys" ADD CONSTRAINT "ads_advertiser_api_keys_advertiser_id_users_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_clicks" ADD CONSTRAINT "ads_clicks_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_clicks" ADD CONSTRAINT "ads_clicks_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_conversions" ADD CONSTRAINT "ads_conversions_advertiser_id_users_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_conversions" ADD CONSTRAINT "ads_conversions_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_conversions" ADD CONSTRAINT "ads_conversions_attributed_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("attributed_promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_advertiser_api_keys_advertiser_idx" ON "ads_advertiser_api_keys" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_advertiser_api_keys_prefix_idx" ON "ads_advertiser_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_clicks_click_id_idx" ON "ads_clicks" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_clicks_campaign_id_idx" ON "ads_clicks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_clicks_promoter_id_idx" ON "ads_clicks" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_clicks_clicked_at_idx" ON "ads_clicks" USING btree ("clicked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversions_advertiser_id_idx" ON "ads_conversions" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversions_campaign_id_idx" ON "ads_conversions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversions_click_id_idx" ON "ads_conversions" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversions_status_idx" ON "ads_conversions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversions_occurred_at_idx" ON "ads_conversions" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ads_conversions_dedupe_idx" ON "ads_conversions" USING btree ("advertiser_id","order_id","event");