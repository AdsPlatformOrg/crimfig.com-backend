CREATE TYPE "public"."ads_dispute_role" AS ENUM('advertiser', 'promoter');--> statement-breakpoint
CREATE TYPE "public"."ads_dispute_status" AS ENUM('open', 'under_review', 'resolved_upheld', 'resolved_adjusted', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opened_by" uuid NOT NULL,
	"role" "ads_dispute_role" NOT NULL,
	"scope" varchar(30) DEFAULT 'campaign' NOT NULL,
	"campaign_id" uuid,
	"placement_id" varchar(100),
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"details" text NOT NULL,
	"status" "ads_dispute_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"adjustment_micros" bigint,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN IF NOT EXISTS "target_cpa_usd_cents" bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN IF NOT EXISTS "target_cpcv_usd_cents" bigint;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN IF NOT EXISTS "attribution_click_days" smallint DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN IF NOT EXISTS "attribution_view_days" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_disputes" ADD CONSTRAINT "ads_disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_disputes" ADD CONSTRAINT "ads_disputes_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_disputes" ADD CONSTRAINT "ads_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_disputes_opened_by_idx" ON "ads_disputes" USING btree ("opened_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_disputes_campaign_id_idx" ON "ads_disputes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_disputes_status_idx" ON "ads_disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_disputes_created_at_idx" ON "ads_disputes" USING btree ("created_at");
