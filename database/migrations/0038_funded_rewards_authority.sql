-- Canonical funded-rewards prerequisites: definitions already present in schema, previously missing from migration history.
-- DDL only: no fund, settings, user balance, point, or provider-payment rows are seeded.
CREATE TYPE "public"."rewards_fund_ledger_type" AS ENUM('sweep_in', 'allocate', 'release', 'spend', 'adjust_in', 'adjust_out');
--> statement-breakpoint
CREATE TYPE "public"."rewards_proposal_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."rewards_point_state" AS ENUM('pending', 'available', 'redemption_reserved', 'redeemed', 'reversed', 'expired');
--> statement-breakpoint
CREATE TYPE "public"."rewards_redemption_type" AS ENUM('wallet_credit', 'ad_credit', 'subscription');
--> statement-breakpoint
CREATE TYPE "public"."rewards_redemption_status" AS ENUM('requested', 'reserved', 'review_required', 'processing', 'completed', 'rejected', 'failed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_fund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" varchar(10) DEFAULT 'USD' NOT NULL,
	"cash_balance_usd_cents" bigint DEFAULT 0 NOT NULL,
	"allocated_usd_cents" bigint DEFAULT 0 NOT NULL,
	"available_usd_cents" bigint DEFAULT 0 NOT NULL,
	"funded_pending_usd_cents" bigint DEFAULT 0 NOT NULL,
	"spent_usd_cents" bigint DEFAULT 0 NOT NULL,
	"reserve_floor_usd_cents" bigint DEFAULT 10000 NOT NULL,
	"fractional_residual_microusd" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_fund_currency_unique" UNIQUE("currency")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_fund_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"type" "rewards_fund_ledger_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"from_bucket" varchar(32) NOT NULL,
	"to_bucket" varchar(32) NOT NULL,
	"cash_balance_after_cents" bigint NOT NULL,
	"available_after_cents" bigint NOT NULL,
	"allocated_after_cents" bigint NOT NULL,
	"funded_pending_after_cents" bigint NOT NULL,
	"source_ref" varchar(128) NOT NULL,
	"description" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_fund_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"rewards_fund_seed_percent" integer DEFAULT 10 NOT NULL,
	"bonus_promoter_incentive_percent" integer DEFAULT 5 NOT NULL,
	"reserve_floor_percent" integer DEFAULT 20 NOT NULL,
	"reserve_floor_min_cents" integer DEFAULT 10000 NOT NULL,
	"daily_emission_cap_points" integer DEFAULT 50000 NOT NULL,
	"monthly_emission_cap_points" integer DEFAULT 1000000 NOT NULL,
	"per_user_daily_cap_points" integer DEFAULT 200 NOT NULL,
	"per_user_monthly_cap_points" integer DEFAULT 3000 NOT NULL,
	"min_redemption_points" integer DEFAULT 1000 NOT NULL,
	"high_value_review_points" integer DEFAULT 2000 NOT NULL,
	"pending_hold_hours" integer DEFAULT 72 NOT NULL,
	"points_expiry_days" integer DEFAULT 365 NOT NULL,
	"ads_rewards_global_paused" boolean DEFAULT false NOT NULL,
	"approved_by" text[] NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_fund_settings_version_unique" UNIQUE("version")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_settings_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_type" varchar(64) NOT NULL,
	"proposed_payload" jsonb NOT NULL,
	"status" "rewards_proposal_status" DEFAULT 'pending' NOT NULL,
	"proposer_id" uuid NOT NULL,
	"approver_id" uuid,
	"proposer_note" text,
	"approver_note" text,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_rewards_suspension_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(32) NOT NULL,
	"target_user_id" uuid,
	"action" varchar(32) NOT NULL,
	"reason" text NOT NULL,
	"performed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_points_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pending_points" integer DEFAULT 0 NOT NULL,
	"available_points" integer DEFAULT 0 NOT NULL,
	"reserved_points" integer DEFAULT 0 NOT NULL,
	"lifetime_earned_points" integer DEFAULT 0 NOT NULL,
	"lifetime_redeemed_points" integer DEFAULT 0 NOT NULL,
	"accumulated_reward_microusd" bigint DEFAULT 0 NOT NULL,
	"is_rewards_suspended" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_points_balances_user_id_unique" UNIQUE("user_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_points_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"delta_points" integer NOT NULL,
	"state" "rewards_point_state" NOT NULL,
	"activity_code" varchar(64) NOT NULL,
	"source_ref" varchar(128) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"valuation_microusd" bigint NOT NULL,
	"rate_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_points_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deferred_reward_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_key" varchar(64) NOT NULL,
	"points_entitled" integer NOT NULL,
	"usd_equivalent_cents" integer NOT NULL,
	"badge_title" varchar(128) NOT NULL,
	"badge_icon" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"funded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"badge_key" varchar(64) NOT NULL,
	"badge_title" varchar(128) NOT NULL,
	"badge_icon" varchar(32) NOT NULL,
	"tier" integer,
	"achieved_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewards_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "rewards_redemption_type" NOT NULL,
	"status" "rewards_redemption_status" DEFAULT 'requested' NOT NULL,
	"points_redeemed" integer NOT NULL,
	"usd_cents_amount" integer NOT NULL,
	"destination_ref" varchar(128),
	"idempotency_key" varchar(128) NOT NULL,
	"reviewer_id" uuid,
	"reviewer_note" text,
	"reviewed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rewards_redemptions_idempotency_key_unique" UNIQUE("idempotency_key")
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_fund_ledger" ADD CONSTRAINT "rewards_fund_ledger_fund_id_rewards_fund_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."rewards_fund"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_fund_ledger" ADD CONSTRAINT "rewards_fund_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_settings_proposals" ADD CONSTRAINT "rewards_settings_proposals_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_settings_proposals" ADD CONSTRAINT "rewards_settings_proposals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_rewards_suspension_audit" ADD CONSTRAINT "ads_rewards_suspension_audit_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ads_rewards_suspension_audit" ADD CONSTRAINT "ads_rewards_suspension_audit_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_points_balances" ADD CONSTRAINT "rewards_points_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_points_ledger" ADD CONSTRAINT "rewards_points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deferred_reward_entitlements" ADD CONSTRAINT "deferred_reward_entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_badges" ADD CONSTRAINT "rewards_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_redemptions" ADD CONSTRAINT "rewards_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewards_redemptions" ADD CONSTRAINT "rewards_redemptions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_fund_currency_idx" ON "rewards_fund" USING btree ("currency");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_fund_ledger_fund_id_idx" ON "rewards_fund_ledger" USING btree ("fund_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_fund_ledger_source_ref_idx" ON "rewards_fund_ledger" USING btree ("source_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_fund_ledger_created_at_idx" ON "rewards_fund_ledger" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_fund_settings_version_idx" ON "rewards_fund_settings" USING btree ("version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_settings_proposals_status_idx" ON "rewards_settings_proposals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_rewards_suspension_audit_target_idx" ON "ads_rewards_suspension_audit" USING btree ("target_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_balances_user_id_idx" ON "rewards_points_balances" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_ledger_user_id_idx" ON "rewards_points_ledger" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_ledger_lot_id_idx" ON "rewards_points_ledger" USING btree ("lot_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_ledger_activity_code_idx" ON "rewards_points_ledger" USING btree ("activity_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_ledger_state_idx" ON "rewards_points_ledger" USING btree ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_points_ledger_expires_at_idx" ON "rewards_points_ledger" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deferred_reward_entitlements_user_key_idx" ON "deferred_reward_entitlements" USING btree ("user_id","reward_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deferred_reward_entitlements_status_idx" ON "deferred_reward_entitlements" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rewards_badges_user_key_idx" ON "rewards_badges" USING btree ("user_id","badge_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_badges_user_id_idx" ON "rewards_badges" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_redemptions_user_id_idx" ON "rewards_redemptions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rewards_redemptions_status_idx" ON "rewards_redemptions" USING btree ("status");
--> statement-breakpoint
-- Reuse rewards_fund and rewards_points_*; no second funded wallet.
ALTER TABLE cfig_ledger ADD COLUMN converted_delta bigint NOT NULL DEFAULT 0;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='cfig_ledger'::regclass AND contype='c' AND pg_get_constraintdef(oid) NOT ILIKE '%reason%' LOOP EXECUTE format('ALTER TABLE cfig_ledger DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE cfig_ledger DROP CONSTRAINT cfig_ledger_event_kind_uq;
CREATE UNIQUE INDEX cfig_ledger_event_kind_uq ON cfig_ledger(event_id,kind) WHERE kind<>'convert';
ALTER TABLE cfig_ledger ADD CONSTRAINT cfig_ledger_moves CHECK(
 (kind='accrue' AND pending_delta>0 AND available_delta=0 AND invalid_delta=0 AND converted_delta=0) OR
 (kind='clear' AND pending_delta<0 AND available_delta=-pending_delta AND invalid_delta=0 AND converted_delta=0) OR
 (kind='invalidate' AND pending_delta<=0 AND available_delta<=0 AND invalid_delta>0 AND invalid_delta=-(pending_delta+available_delta) AND converted_delta=0) OR
 (kind='convert' AND pending_delta=0 AND available_delta<0 AND invalid_delta=0 AND converted_delta=-available_delta));
CREATE TABLE reward_program_allocations (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,program text NOT NULL CHECK(program IN('paid_performance','house_conversion')),
 fund_id uuid NOT NULL REFERENCES rewards_fund(id),proof_id uuid NOT NULL UNIQUE REFERENCES billing_provider_events(id),
 backing_source_ref uuid NOT NULL UNIQUE REFERENCES rewards_fund_ledger(id),amount_cents bigint NOT NULL CHECK(amount_cents>0),policy_snapshot jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),
 approved_by uuid REFERENCES users(id),approval_request_id uuid UNIQUE,approved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(approved_by IS NULL OR approved_by<>created_by),
 CHECK((approved_at IS NULL AND approved_by IS NULL AND approval_request_id IS NULL) OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approval_request_id IS NOT NULL))
);
CREATE TABLE reward_program_issues (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,allocation_id uuid REFERENCES reward_program_allocations(id),
 user_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN('paid_loop','cfig_conversion','legacy_clearance')),
 points integer NOT NULL CHECK(points>0),micro_cfig bigint NOT NULL DEFAULT 0 CHECK(micro_cfig>=0),
 source_ref text NOT NULL UNIQUE,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_performance_receipts (
 event_id uuid PRIMARY KEY REFERENCES ads_interactions(id),request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,serve_id uuid NOT NULL UNIQUE REFERENCES ads_serves(id),
 promoter_id uuid NOT NULL REFERENCES ads_promoters(id),user_id uuid NOT NULL REFERENCES users(id),model text NOT NULL CHECK(model IN('cpc','cpm')),
 allocation_id uuid NOT NULL REFERENCES reward_program_allocations(id),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_issuance_periods (
 period text NOT NULL,kind text NOT NULL CHECK(kind IN('day','month')),cap_points integer NOT NULL CHECK(cap_points>=0),snapshot jsonb NOT NULL,
 PRIMARY KEY(period,kind)
);
CREATE TABLE reward_recovery_cases (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,issue_id uuid NOT NULL REFERENCES reward_program_issues(id),
 evidence_id uuid NOT NULL REFERENCES ads_event_assessments(id),actor_id uuid NOT NULL REFERENCES users(id),reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(issue_id,evidence_id)
);
CREATE TRIGGER reward_issues_immutable BEFORE UPDATE OR DELETE ON reward_program_issues FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_receipts_immutable BEFORE UPDATE OR DELETE ON reward_performance_receipts FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_periods_immutable BEFORE UPDATE OR DELETE ON reward_issuance_periods FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_recovery_immutable BEFORE UPDATE OR DELETE ON reward_recovery_cases FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE FUNCTION protect_reward_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Allocation history cannot be deleted'; END IF;
 IF OLD.approved_at IS NOT NULL OR NEW.policy_snapshot IS DISTINCT FROM OLD.policy_snapshot OR NEW.amount_cents<>OLD.amount_cents OR NEW.fund_id<>OLD.fund_id OR NEW.proof_id<>OLD.proof_id OR NEW.backing_source_ref<>OLD.backing_source_ref OR NEW.created_by<>OLD.created_by OR NEW.request_id<>OLD.request_id OR NEW.fingerprint<>OLD.fingerprint OR NEW.program<>OLD.program OR NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Immutable allocation terms'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER reward_allocation_immutable BEFORE UPDATE OR DELETE ON reward_program_allocations FOR EACH ROW EXECUTE FUNCTION protect_reward_allocation();

-- Source-only attestations: these never create cash, issue points, or change balances.
CREATE TABLE reward_reconciliation_reviews (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,fingerprint text NOT NULL,kind text NOT NULL CHECK(kind IN('backing','clearance')),
 source_id uuid NOT NULL,source_snapshot jsonb NOT NULL,source_hash text NOT NULL,prepared_by uuid NOT NULL REFERENCES users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE TABLE reward_reconciliation_approvals (
 review_id uuid PRIMARY KEY REFERENCES reward_reconciliation_reviews(id),request_id uuid NOT NULL UNIQUE,
 proof_id uuid NOT NULL UNIQUE REFERENCES billing_provider_events(id),approved_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL
);
CREATE TRIGGER reward_reconciliation_reviews_immutable BEFORE UPDATE OR DELETE ON reward_reconciliation_reviews FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER reward_reconciliation_approvals_immutable BEFORE UPDATE OR DELETE ON reward_reconciliation_approvals FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();

-- Existing canonical funded ledgers are append-only; state changes append compensating entries.
CREATE TRIGGER rewards_fund_history_immutable BEFORE UPDATE OR DELETE ON rewards_fund_ledger FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
CREATE TRIGGER rewards_points_history_immutable BEFORE UPDATE OR DELETE ON rewards_points_ledger FOR EACH ROW EXECUTE FUNCTION reject_cfig_history_mutation();
