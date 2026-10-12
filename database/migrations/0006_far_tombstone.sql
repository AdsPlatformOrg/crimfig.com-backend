CREATE TABLE IF NOT EXISTS "monetization_account_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"qualification_reason" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_commission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"rule_name" text NOT NULL,
	"target_type" text NOT NULL,
	"commission_percent" numeric(5, 4) NOT NULL,
	"max_cap_usd_cents" bigint,
	"duration_days" integer,
	"eligibility_criteria" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_earning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_reference_id" text,
	"event_type" text NOT NULL,
	"verified_units" integer DEFAULT 1 NOT NULL,
	"gross_billable_usd_cents" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'verified' NOT NULL,
	"metadata" jsonb,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monetization_earning_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"earning_model" text DEFAULT 'qualified_interactions' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monetization_products_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_revenue_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"name" text NOT NULL,
	"publisher_share_ratio" numeric(5, 4) NOT NULL,
	"platform_share_ratio" numeric(5, 4) NOT NULL,
	"commission_pool_ratio" numeric(5, 4) NOT NULL,
	"max_external_referral_ratio" numeric(5, 4) DEFAULT '0.1500' NOT NULL,
	"default_external_referral_ratio" numeric(5, 4) DEFAULT '0.1000' NOT NULL,
	"default_internal_marketing_ratio" numeric(5, 4) DEFAULT '0.0500' NOT NULL,
	"performance_bonus_ratio" numeric(5, 4) DEFAULT '0.0000' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_settlement_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_number" text NOT NULL,
	"product_id" uuid NOT NULL,
	"revenue_policy_id" uuid,
	"tier_id" uuid,
	"entity_type" text NOT NULL,
	"beneficiary_user_id" uuid,
	"source_batch_id" text,
	"source_item_id" text,
	"direction" text NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"publisher_ratio_snapshot" numeric(5, 4),
	"platform_ratio_snapshot" numeric(5, 4),
	"commission_pool_ratio_snapshot" numeric(5, 4),
	"exchange_rate_snapshot" numeric(12, 4),
	"idempotency_key" text NOT NULL,
	"billing_transaction_id" uuid,
	"status" text DEFAULT 'posted' NOT NULL,
	"payout_status" text DEFAULT 'unpaid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monetization_settlement_entries_entry_number_unique" UNIQUE("entry_number"),
	CONSTRAINT "monetization_settlement_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monetization_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monetization_tiers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" DROP CONSTRAINT "ads_promoter_settlement_items_batch_id_ads_settlement_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "ads_campaign_escrows" ALTER COLUMN "allocated_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaign_escrows" ALTER COLUMN "consumed_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_campaign_escrows" ALTER COLUMN "refunded_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "earned_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "billed_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "publisher_pool_ratio" SET DEFAULT '0.5500';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ALTER COLUMN "tax_and_fees_ratio" SET DEFAULT '0.0000';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "total_debited_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "total_credited_usd_cents" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "publisher_pool_ratio" SET DEFAULT '0.5500';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "platform_share_ratio" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "tax_and_fees_ratio" SET DEFAULT '0.0000';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ALTER COLUMN "tax_and_fees_ratio" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "revenue_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "tier_snapshot" text DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "crimfig_base_revenue_ratio" numeric(5, 4) DEFAULT '0.3000';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "commission_pool_ratio" numeric(5, 4) DEFAULT '0.1500';--> statement-breakpoint
ALTER TABLE "ads_promoter_settlement_items" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "total_commission_paid_usd_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "crimfig_base_revenue_ratio" numeric(5, 4) DEFAULT '0.3000' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "commission_pool_ratio" numeric(5, 4) DEFAULT '0.1500' NOT NULL;--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "commission_paid_ratio" numeric(5, 4) DEFAULT '0.0000';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "crimfig_total_retained_ratio" numeric(5, 4) DEFAULT '0.4500';--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_account_tiers" ADD CONSTRAINT "monetization_account_tiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_account_tiers" ADD CONSTRAINT "monetization_account_tiers_product_id_monetization_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."monetization_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_account_tiers" ADD CONSTRAINT "monetization_account_tiers_tier_id_monetization_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."monetization_tiers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_account_tiers" ADD CONSTRAINT "monetization_account_tiers_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_commission_rules" ADD CONSTRAINT "monetization_commission_rules_product_id_monetization_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."monetization_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_earning_events" ADD CONSTRAINT "monetization_earning_events_product_id_monetization_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."monetization_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_earning_events" ADD CONSTRAINT "monetization_earning_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_revenue_policies" ADD CONSTRAINT "monetization_revenue_policies_product_id_monetization_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."monetization_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_revenue_policies" ADD CONSTRAINT "monetization_revenue_policies_tier_id_monetization_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."monetization_tiers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_settlement_entries" ADD CONSTRAINT "monetization_settlement_entries_product_id_monetization_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."monetization_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_settlement_entries" ADD CONSTRAINT "monetization_settlement_entries_revenue_policy_id_monetization_revenue_policies_id_fk" FOREIGN KEY ("revenue_policy_id") REFERENCES "public"."monetization_revenue_policies"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_settlement_entries" ADD CONSTRAINT "monetization_settlement_entries_tier_id_monetization_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."monetization_tiers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_settlement_entries" ADD CONSTRAINT "monetization_settlement_entries_beneficiary_user_id_users_id_fk" FOREIGN KEY ("beneficiary_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monetization_settlement_entries" ADD CONSTRAINT "monetization_settlement_entries_billing_transaction_id_billing_transactions_id_fk" FOREIGN KEY ("billing_transaction_id") REFERENCES "public"."billing_transactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_account_tiers_user_product_idx" ON "monetization_account_tiers" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_account_tiers_is_active_idx" ON "monetization_account_tiers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_commission_rules_product_target_idx" ON "monetization_commission_rules" USING btree ("product_id","target_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_commission_rules_is_active_idx" ON "monetization_commission_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_earning_events_product_user_idx" ON "monetization_earning_events" USING btree ("product_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_earning_events_status_idx" ON "monetization_earning_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_earning_events_created_at_idx" ON "monetization_earning_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_products_code_idx" ON "monetization_products" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_products_is_active_idx" ON "monetization_products" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_revenue_policies_product_tier_idx" ON "monetization_revenue_policies" USING btree ("product_id","tier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_revenue_policies_is_active_idx" ON "monetization_revenue_policies" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_product_id_idx" ON "monetization_settlement_entries" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_beneficiary_user_idx" ON "monetization_settlement_entries" USING btree ("beneficiary_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_source_batch_idx" ON "monetization_settlement_entries" USING btree ("source_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_status_idx" ON "monetization_settlement_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_payout_status_idx" ON "monetization_settlement_entries" USING btree ("payout_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_settlement_entries_created_at_idx" ON "monetization_settlement_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_tiers_code_idx" ON "monetization_tiers" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monetization_tiers_priority_idx" ON "monetization_tiers" USING btree ("priority");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_promoter_settlement_items" ADD CONSTRAINT "ads_promoter_settlement_items_batch_id_ads_settlement_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ads_settlement_batches"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "ads_settlement_batches" ADD CONSTRAINT "ads_settlement_batches_idempotency_key_unique" UNIQUE("idempotency_key");