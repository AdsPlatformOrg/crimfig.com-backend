ALTER TABLE "advertiser_promo_budget"
  ADD COLUMN IF NOT EXISTS "reserved_liability_cents" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "paid_promoter_earnings_cents" bigint NOT NULL DEFAULT 0;

ALTER TABLE "ads_campaigns"
  ADD COLUMN IF NOT EXISTS "bonus_reserved_cents" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bonus_spent_cents" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "program_feature_switches" (
  "key" text PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "is_locked_off" boolean NOT NULL DEFAULT false,
  "label" text NOT NULL,
  "description" text NOT NULL,
  "updated_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "program_feature_switch_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "switch_key" text NOT NULL REFERENCES "public"."program_feature_switches"("key") ON DELETE RESTRICT,
  "previous_enabled" boolean NOT NULL,
  "next_enabled" boolean NOT NULL,
  "reason" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "actor_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "program_switch_audit_key_idx"
  ON "program_feature_switch_audit" ("switch_key", "created_at");

CREATE TABLE IF NOT EXISTS "platform_operating_reserve" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD' UNIQUE,
  "available_cents" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "platform_reserve_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "from_reserve" text NOT NULL,
  "to_reserve" text NOT NULL,
  "amount_cents" bigint NOT NULL CHECK ("amount_cents" > 0),
  "reason" text NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_reserve_transfers_created_idx"
  ON "platform_reserve_transfers" ("created_at");

CREATE TABLE IF NOT EXISTS "advertiser_bonus_credits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "advertiser_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "milestone_id" text NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "policy_version" text NOT NULL,
  "qualifying_spend_cents" bigint NOT NULL,
  "credit_cents" integer NOT NULL,
  "remaining_credit_cents" integer NOT NULL,
  "reserved_credit_cents" integer NOT NULL DEFAULT 0,
  "consumed_credit_cents" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'available',
  "terms_accepted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "claimed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "advertiser_bonus_credits_owner_tier_uq"
  ON "advertiser_bonus_credits" ("advertiser_id", "milestone_id");

CREATE INDEX IF NOT EXISTS "advertiser_bonus_credits_owner_idx"
  ON "advertiser_bonus_credits" ("advertiser_id", "claimed_at");

CREATE TABLE IF NOT EXISTS "advertiser_bonus_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "advertiser_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "credit_id" uuid REFERENCES "public"."advertiser_bonus_credits"("id") ON DELETE RESTRICT,
  "campaign_id" uuid REFERENCES "public"."ads_campaigns"("id") ON DELETE SET NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "amount_cents" integer NOT NULL,
  "balance_after_cents" integer NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "advertiser_bonus_ledger_owner_idx"
  ON "advertiser_bonus_ledger" ("advertiser_id", "created_at");

CREATE TABLE IF NOT EXISTS "platform_admin_silent_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "category" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'info',
  "advertiser_id" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "campaign_id" uuid REFERENCES "public"."ads_campaigns"("id") ON DELETE SET NULL,
  "milestone_id" text,
  "summary" text NOT NULL,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'open',
  "acknowledged_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "acknowledged_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_admin_silent_alerts_status_idx"
  ON "platform_admin_silent_alerts" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "bonus_promo_impressions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "serve_id" uuid NOT NULL UNIQUE REFERENCES "public"."ads_serves"("id") ON DELETE RESTRICT,
  "interaction_id" uuid NOT NULL UNIQUE REFERENCES "public"."ads_interactions"("id") ON DELETE RESTRICT,
  "campaign_id" uuid NOT NULL REFERENCES "public"."ads_campaigns"("id") ON DELETE RESTRICT,
  "advertiser_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE RESTRICT,
  "promoter_id" uuid NOT NULL REFERENCES "public"."ads_promoters"("id") ON DELETE RESTRICT,
  "website_id" uuid NOT NULL REFERENCES "public"."ads_promoter_websites"("id") ON DELETE RESTRICT,
  "face_value_microusd" bigint NOT NULL,
  "promoter_earnings_microusd" bigint NOT NULL,
  "clearance_status" text NOT NULL DEFAULT 'pending',
  "hold_expires_at" timestamp with time zone NOT NULL,
  "cleared_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "bonus_promo_impressions_clearance_idx"
  ON "bonus_promo_impressions" ("clearance_status", "hold_expires_at");

INSERT INTO "program_feature_switches" ("key", "enabled", "is_locked_off", "label", "description")
VALUES
  ('advertiser_bonus_credit', true, false, 'Advertiser Bonus Ad Credit', 'Allow verified advertisers to claim non-withdrawable bonus ad credit for A1-A4 and Prestige 10K/100K/1M milestones ($3,320 lifetime max).'),
  ('bonus_ad_delivery', true, false, 'Bonus-Ad Promotional Delivery (Unsold Inventory)', 'Deliver approved 100% bonus-credit campaigns on eligible unsold inventory at $0.50 base CPM with 55% promoter earnings from Promotional Ad Reserve.'),
  ('house_cfig_earning', true, false, 'House Ad $CFIG Virtual Earning', 'Allow verified approved websites to earn virtual $CFIG units from House Ads (20/day & 300/mo site, 5/day & 75/mo site clicks, 60/day & 900/mo promoter, 500k/mo global).'),
  ('redeemable_points', true, false, 'Promoter Redeemable Points', 'Paid-performance Redeemable Points issuance and funded USD wallet redemptions (100 Points = $1.00 USD).'),
  ('cfig_to_points_conversion', false, true, '$CFIG -> Redeemable Points Conversion', 'Locked OFF at launch pending separate approval and dedicated Rewards Fund cash backing (100 $CFIG = 1 Point; direct $CFIG -> USD permanently prohibited).')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "platform_operating_reserve" ("currency", "available_cents")
VALUES ('USD', 0)
ON CONFLICT ("currency") DO NOTHING;

INSERT INTO "advertiser_promo_budget" ("total_allocated_cents", "issued_bonus_credits_cents", "consumed_bonus_credits_cents", "remaining_promo_budget_cents", "reserved_liability_cents", "paid_promoter_earnings_cents", "is_issuance_halted")
SELECT 0, 0, 0, 0, 0, 0, false
WHERE NOT EXISTS (SELECT 1 FROM "advertiser_promo_budget");
