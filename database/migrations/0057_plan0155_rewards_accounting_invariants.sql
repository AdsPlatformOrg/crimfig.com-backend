-- PLAN-0155: Live Rewards accounting, sub-cent carry, per-campaign grant consumption,
-- source-bound operating proceeds uniqueness, conservation constraints, and append-only audit protections.

ALTER TABLE "platform_reserve_transfers"
  ADD COLUMN IF NOT EXISTS "source_ref" text;

CREATE UNIQUE INDEX IF NOT EXISTS "platform_reserve_proceeds_source_uq"
  ON "platform_reserve_transfers" ("source_ref")
  WHERE "from_reserve" = 'realized_platform_proceeds' AND "source_ref" IS NOT NULL;

ALTER TABLE "bonus_promo_impressions"
  ADD COLUMN IF NOT EXISTS "creative_id" uuid REFERENCES "public"."ads_creatives"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "payout_batch_id" uuid,
  ADD COLUMN IF NOT EXISTS "billing_transaction_id" uuid REFERENCES "public"."billing_transactions"("id") ON DELETE RESTRICT;

UPDATE "bonus_promo_impressions" b
SET "creative_id" = s."creative_id"
FROM "ads_serves" s
WHERE s."id" = b."serve_id" AND b."creative_id" IS NULL;

CREATE INDEX IF NOT EXISTS "bonus_promo_impressions_campaign_created_idx"
  ON "bonus_promo_impressions" ("campaign_id", "created_at");

CREATE INDEX IF NOT EXISTS "bonus_promo_impressions_promoter_created_idx"
  ON "bonus_promo_impressions" ("promoter_id", "created_at");

CREATE TABLE IF NOT EXISTS "bonus_promo_promoter_carries" (
  "promoter_id" uuid PRIMARY KEY REFERENCES "public"."ads_promoters"("id") ON DELETE RESTRICT,
  "carry_microusd" bigint NOT NULL DEFAULT 0 CHECK ("carry_microusd" >= 0 AND "carry_microusd" < 10000),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "advertiser_bonus_campaign_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "public"."ads_campaigns"("id") ON DELETE RESTRICT,
  "credit_id" uuid NOT NULL REFERENCES "public"."advertiser_bonus_credits"("id") ON DELETE RESTRICT,
  "advertiser_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "allocated_cents" integer NOT NULL CHECK ("allocated_cents" >= 0),
  "reserved_cents" integer NOT NULL DEFAULT 0 CHECK ("reserved_cents" >= 0),
  "consumed_cents" integer NOT NULL DEFAULT 0 CHECK ("consumed_cents" >= 0),
  "released_cents" integer NOT NULL DEFAULT 0 CHECK ("released_cents" >= 0),
  "consumed_microusd" bigint NOT NULL DEFAULT 0 CHECK ("consumed_microusd" >= 0 AND "consumed_microusd" <= "consumed_cents"::bigint * 10000),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE ("campaign_id", "credit_id"),
  CHECK ("reserved_cents" + "consumed_cents" + "released_cents" = "allocated_cents")
);

CREATE INDEX IF NOT EXISTS "advertiser_bonus_campaign_alloc_campaign_idx"
  ON "advertiser_bonus_campaign_allocations" ("campaign_id");

DO $$ BEGIN
  ALTER TABLE "advertiser_bonus_credits"
    ADD CONSTRAINT "advertiser_bonus_credits_conservation_chk"
    CHECK (
      "credit_cents" > 0
      AND "remaining_credit_cents" >= 0
      AND "reserved_credit_cents" >= 0
      AND "consumed_credit_cents" >= 0
      AND "remaining_credit_cents" + "reserved_credit_cents" + "consumed_credit_cents" = "credit_cents"
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "platform_operating_reserve"
    ADD CONSTRAINT "platform_operating_reserve_nonneg_chk"
    CHECK ("available_cents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "advertiser_promo_budget"
    ADD CONSTRAINT "advertiser_promo_budget_nonneg_chk"
    CHECK (
      "remaining_promo_budget_cents" >= 0
      AND "reserved_liability_cents" >= 0
      AND "paid_promoter_earnings_cents" >= 0
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION protect_rewards_audit_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rewards financial audit ledger (%) is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS "program_switch_audit_immutable" ON "program_feature_switch_audit";
CREATE TRIGGER "program_switch_audit_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "program_feature_switch_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION protect_rewards_audit_ledger();

DROP TRIGGER IF EXISTS "platform_reserve_transfers_immutable" ON "platform_reserve_transfers";
CREATE TRIGGER "platform_reserve_transfers_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "platform_reserve_transfers"
  FOR EACH STATEMENT EXECUTE FUNCTION protect_rewards_audit_ledger();

DROP TRIGGER IF EXISTS "advertiser_bonus_ledger_immutable" ON "advertiser_bonus_ledger";
CREATE TRIGGER "advertiser_bonus_ledger_immutable"
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "advertiser_bonus_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION protect_rewards_audit_ledger();
