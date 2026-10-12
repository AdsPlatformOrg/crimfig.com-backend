CREATE TYPE "public"."ads_escrow_status" AS ENUM('active', 'exhausted', 'released');--> statement-breakpoint
CREATE TYPE "public"."ads_settlement_batch_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_campaign_escrows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"allocated_usd_cents" integer NOT NULL,
	"consumed_usd_cents" integer DEFAULT 0 NOT NULL,
	"refunded_usd_cents" integer DEFAULT 0 NOT NULL,
	"status" "ads_escrow_status" DEFAULT 'active' NOT NULL,
	"last_settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoter_settlement_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"placement_id" uuid,
	"campaign_id" uuid NOT NULL,
	"impressions_count" integer DEFAULT 0 NOT NULL,
	"clicks_count" integer DEFAULT 0 NOT NULL,
	"hovers_count" integer DEFAULT 0 NOT NULL,
	"touches_count" integer DEFAULT 0 NOT NULL,
	"earned_usd_cents" integer DEFAULT 0 NOT NULL,
	"billed_usd_cents" integer DEFAULT 0 NOT NULL,
	"billing_transaction_id" uuid,
	"status" text DEFAULT 'credited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_settlement_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total_impressions" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"total_hovers" integer DEFAULT 0 NOT NULL,
	"total_touches" integer DEFAULT 0 NOT NULL,
	"total_debited_usd_cents" integer DEFAULT 0 NOT NULL,
	"total_credited_usd_cents" integer DEFAULT 0 NOT NULL,
	"status" "ads_settlement_batch_status" DEFAULT 'processing' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ads_settlement_batches_batch_number_unique" UNIQUE("batch_number")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_campaign_escrows" ADD CONSTRAINT "ads_campaign_escrows_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_campaign_escrows" ADD CONSTRAINT "ads_campaign_escrows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_batch_id_ads_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ads_settlement_batches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_placement_id_ads_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ads_placements"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_billing_transaction_id_billing_transactions_id_fk" FOREIGN KEY ("billing_transaction_id") REFERENCES "public"."billing_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_campaign_escrows_campaign_id_idx" ON "ads_campaign_escrows" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_campaign_escrows_user_id_idx" ON "ads_campaign_escrows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_campaign_escrows_status_idx" ON "ads_campaign_escrows" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_settlement_items_batch_id_idx" ON "ads_promoter_settlement_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_settlement_items_promoter_id_idx" ON "ads_promoter_settlement_items" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_settlement_items_campaign_id_idx" ON "ads_promoter_settlement_items" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_batches_number_idx" ON "ads_settlement_batches" USING btree ("batch_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_batches_status_idx" ON "ads_settlement_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_batches_created_at_idx" ON "ads_settlement_batches" USING btree ("created_at");