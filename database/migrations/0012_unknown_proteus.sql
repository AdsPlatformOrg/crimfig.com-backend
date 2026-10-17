CREATE TABLE IF NOT EXISTS "ads_deep_audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_number" varchar(50) NOT NULL,
	"audit_level" varchar(20) NOT NULL,
	"lookback_hours" integer DEFAULT 72 NOT NULL,
	"total_interactions_analyzed" integer DEFAULT 0 NOT NULL,
	"total_invalidated_clicks" integer DEFAULT 0 NOT NULL,
	"total_rebates_issued_usd_cents" bigint DEFAULT 0 NOT NULL,
	"total_penalties_issued_usd_cents" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"notes" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ads_deep_audit_runs_run_number_unique" UNIQUE("run_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_promoter_penalties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promoter_id" uuid NOT NULL,
	"audit_run_id" uuid,
	"audit_level" varchar(20) NOT NULL,
	"penalty_amount_usd_cents" bigint NOT NULL,
	"recovered_amount_usd_cents" bigint DEFAULT 0 NOT NULL,
	"status" varchar(30) DEFAULT 'outstanding' NOT NULL,
	"reason_code" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_settlement_rebates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_run_id" uuid,
	"billing_transaction_id" uuid,
	"source_process_type" varchar(50) NOT NULL,
	"campaign_id" uuid NOT NULL,
	"advertiser_id" uuid NOT NULL,
	"promoter_id" uuid,
	"rebate_amount_usd_cents" bigint NOT NULL,
	"rebate_reason_code" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "primary_reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "primary_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "manager_reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "ads_campaigns" ADD COLUMN "manager_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "clearance_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "hold_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "cleared_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_penalties" ADD CONSTRAINT "ads_promoter_penalties_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_penalties" ADD CONSTRAINT "ads_promoter_penalties_audit_run_id_ads_deep_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."ads_deep_audit_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_settlement_rebates" ADD CONSTRAINT "ads_settlement_rebates_audit_run_id_ads_deep_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."ads_deep_audit_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_settlement_rebates" ADD CONSTRAINT "ads_settlement_rebates_billing_transaction_id_billing_transactions_id_fk" FOREIGN KEY ("billing_transaction_id") REFERENCES "public"."billing_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_settlement_rebates" ADD CONSTRAINT "ads_settlement_rebates_campaign_id_ads_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ads_campaigns"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_settlement_rebates" ADD CONSTRAINT "ads_settlement_rebates_advertiser_id_users_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_settlement_rebates" ADD CONSTRAINT "ads_settlement_rebates_promoter_id_ads_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."ads_promoters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_deep_audit_runs_level_idx" ON "ads_deep_audit_runs" USING btree ("audit_level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_deep_audit_runs_started_at_idx" ON "ads_deep_audit_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_penalties_promoter_idx" ON "ads_promoter_penalties" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_promoter_penalties_status_idx" ON "ads_promoter_penalties" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_rebates_campaign_idx" ON "ads_settlement_rebates" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_rebates_advertiser_idx" ON "ads_settlement_rebates" USING btree ("advertiser_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_settlement_rebates_run_idx" ON "ads_settlement_rebates" USING btree ("audit_run_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_campaigns" ADD CONSTRAINT "ads_campaigns_primary_reviewer_id_users_id_fk" FOREIGN KEY ("primary_reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_campaigns" ADD CONSTRAINT "ads_campaigns_manager_reviewer_id_users_id_fk" FOREIGN KEY ("manager_reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
