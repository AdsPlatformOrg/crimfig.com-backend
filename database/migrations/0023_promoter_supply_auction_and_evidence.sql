-- PLAN-0047 & PLAN-0049: Promoter Website Supply Admission, Canonical Ad Slots,
-- House/Shadow Delivery, Auditable Auctions, Opportunity Exposure Holds & GIVT/SIVT Evidence

-- 1. Extend ads_interaction_type enum with 'render' receipt
ALTER TYPE "public"."ads_interaction_type" ADD VALUE IF NOT EXISTS 'render';

-- 2. Extend ads_promoter_websites with AdStation (PLAN-0018) & policy review lifecycle (PLAN-0047)
ALTER TABLE "ads_promoter_websites"
  ADD COLUMN IF NOT EXISTS "delivery_preference" varchar(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS "consideration_slot_active" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "consideration_slot_verified_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "policy_status" varchar(32) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS "policy_revision" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "review_note" text,
  ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;

UPDATE "ads_promoter_websites"
SET "policy_status" = CASE
  WHEN "is_suspended" = true THEN 'suspended'
  WHEN "verification_status" = 'verified' AND "consideration_slot_active" = true THEN 'approved'
  WHEN "verification_status" = 'verified' THEN 'testing'
  ELSE 'unverified'
END
WHERE "policy_status" = 'unverified';

-- 3. Ensure AdStation tables & enums exist (PLAN-0018) and extend adstation_slots with canonical slot lifecycle (PLAN-0047)
DO $$ BEGIN
  CREATE TYPE "public"."adstation_slot_type" AS ENUM ('consideration', 'direct', 'network', 'hybrid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."adstation_direct_campaign_status" AS ENUM ('draft', 'active', 'paused', 'completed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "adstation_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "website_id" uuid NOT NULL REFERENCES "ads_promoter_websites"("id") ON DELETE CASCADE,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE CASCADE,
  "name" varchar(150) NOT NULL,
  "slot_type" "public"."adstation_slot_type" NOT NULL DEFAULT 'direct',
  "format" varchar(50) NOT NULL DEFAULT 'banner',
  "is_consideration_slot" boolean NOT NULL DEFAULT false,
  "is_consideration_verified" boolean NOT NULL DEFAULT false,
  "consideration_last_checked_at" timestamptz,
  "slot_delivery_preference" varchar(20),
  "slot_tag_id" varchar(64) NOT NULL UNIQUE,
  "lifecycle_status" varchar(32) NOT NULL DEFAULT 'installation_pending',
  "width" integer,
  "height" integer,
  "responsive" boolean NOT NULL DEFAULT true,
  "allowed_ad_types" text,
  "installation_status" varchar(24) NOT NULL DEFAULT 'unchecked',
  "installation_checked_at" timestamptz,
  "installation_diagnostic" text,
  "policy_revision" integer NOT NULL DEFAULT 1,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "adstation_slots_website_id_idx" ON "adstation_slots" ("website_id");
CREATE INDEX IF NOT EXISTS "adstation_slots_promoter_id_idx" ON "adstation_slots" ("promoter_id");
CREATE INDEX IF NOT EXISTS "adstation_slots_slot_type_idx" ON "adstation_slots" ("slot_type");
CREATE INDEX IF NOT EXISTS "adstation_slots_tag_id_idx" ON "adstation_slots" ("slot_tag_id");

ALTER TABLE "adstation_slots"
  ADD COLUMN IF NOT EXISTS "lifecycle_status" varchar(32) NOT NULL DEFAULT 'installation_pending',
  ADD COLUMN IF NOT EXISTS "width" integer,
  ADD COLUMN IF NOT EXISTS "height" integer,
  ADD COLUMN IF NOT EXISTS "responsive" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "allowed_ad_types" text,
  ADD COLUMN IF NOT EXISTS "installation_status" varchar(24) NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS "installation_checked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "installation_diagnostic" text,
  ADD COLUMN IF NOT EXISTS "policy_revision" integer NOT NULL DEFAULT 1;

UPDATE "adstation_slots"
SET "lifecycle_status" = CASE
  WHEN "is_active" = false THEN 'paused'
  WHEN "is_consideration_verified" = true THEN 'active'
  ELSE 'testing'
END,
"installation_status" = CASE
  WHEN "is_consideration_verified" = true THEN 'verified'
  ELSE 'unchecked'
END;

CREATE TABLE IF NOT EXISTS "adstation_direct_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE CASCADE,
  "website_id" uuid NOT NULL REFERENCES "ads_promoter_websites"("id") ON DELETE CASCADE,
  "slot_id" uuid REFERENCES "adstation_slots"("id") ON DELETE SET NULL,
  "client_name" varchar(150) NOT NULL,
  "campaign_title" varchar(255) NOT NULL,
  "destination_url" text NOT NULL,
  "headline" text,
  "image_url" text,
  "video_url" text,
  "target_impressions" bigint NOT NULL DEFAULT 0,
  "delivered_impressions" bigint NOT NULL DEFAULT 0,
  "delivered_clicks" bigint NOT NULL DEFAULT 0,
  "status" "public"."adstation_direct_campaign_status" NOT NULL DEFAULT 'active',
  "starts_at" timestamptz NOT NULL DEFAULT now(),
  "ends_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "adstation_direct_campaigns_promoter_id_idx" ON "adstation_direct_campaigns" ("promoter_id");
CREATE INDEX IF NOT EXISTS "adstation_direct_campaigns_website_id_idx" ON "adstation_direct_campaigns" ("website_id");
CREATE INDEX IF NOT EXISTS "adstation_direct_campaigns_slot_id_idx" ON "adstation_direct_campaigns" ("slot_id");
CREATE INDEX IF NOT EXISTS "adstation_direct_campaigns_status_idx" ON "adstation_direct_campaigns" ("status");

CREATE TABLE IF NOT EXISTS "adstation_ad_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "direct_campaign_id" uuid NOT NULL REFERENCES "adstation_direct_campaigns"("id") ON DELETE CASCADE,
  "slot_id" uuid REFERENCES "adstation_slots"("id") ON DELETE SET NULL,
  "website_id" uuid NOT NULL REFERENCES "ads_promoter_websites"("id") ON DELETE CASCADE,
  "event_type" varchar(32) NOT NULL,
  "idempotency_key" varchar(128) NOT NULL UNIQUE,
  "is_viewable" boolean NOT NULL DEFAULT false,
  "view_duration_ms" bigint NOT NULL DEFAULT 0,
  "ip_hash" varchar(64),
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "adstation_ad_events_campaign_idx" ON "adstation_ad_events" ("direct_campaign_id");
CREATE INDEX IF NOT EXISTS "adstation_ad_events_slot_idx" ON "adstation_ad_events" ("slot_id");
CREATE INDEX IF NOT EXISTS "adstation_ad_events_website_idx" ON "adstation_ad_events" ("website_id");
CREATE INDEX IF NOT EXISTS "adstation_ad_events_type_idx" ON "adstation_ad_events" ("event_type");
CREATE INDEX IF NOT EXISTS "adstation_ad_events_created_idx" ON "adstation_ad_events" ("created_at");

DO $$ BEGIN
  CREATE TYPE "public"."advertiser_milestone_tier" AS ENUM (
    'A1_FIRST_CAMPAIGN',
    'A2_CONSISTENT',
    'A3_GROWTH',
    'A4_TRUSTED',
    'B1_LEGACY_5YR',
    'B2_LEGACY_10YR',
    'B3_LEGACY_15YR',
    'B4_LEGACY_20YR',
    'B5_LEGACY_25YR',
    'B6_LEGACY_30YR'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "advertiser_promo_budget" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "total_allocated_cents" bigint NOT NULL DEFAULT 0,
  "issued_bonus_credits_cents" bigint NOT NULL DEFAULT 0,
  "consumed_bonus_credits_cents" bigint NOT NULL DEFAULT 0,
  "remaining_promo_budget_cents" bigint NOT NULL DEFAULT 0,
  "is_issuance_halted" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "advertiser_achievements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "advertiser_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tier" "public"."advertiser_milestone_tier" NOT NULL,
  "badge_title" varchar(100) NOT NULL,
  "badge_icon" varchar(50) NOT NULL,
  "bonus_credit_cents" integer NOT NULL DEFAULT 0,
  "bonus_credit_remaining_cents" integer NOT NULL DEFAULT 0,
  "credit_expires_at" timestamptz,
  "qualifying_spend_cents" bigint NOT NULL DEFAULT 0,
  "qualifying_campaign_count" integer NOT NULL DEFAULT 0,
  "is_clawed_back" boolean NOT NULL DEFAULT false,
  "clawback_reason" text,
  "achieved_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "advertiser_achievements_advertiser_id_idx" ON "advertiser_achievements" ("advertiser_id");
CREATE INDEX IF NOT EXISTS "advertiser_achievements_tier_idx" ON "advertiser_achievements" ("tier");

-- 4. Extend ads_serves with supply admission, delivery mode, financial eligibility & decision links
ALTER TABLE "ads_serves"
  ADD COLUMN IF NOT EXISTS "request_id" uuid,
  ADD COLUMN IF NOT EXISTS "website_id" uuid,
  ADD COLUMN IF NOT EXISTS "slot_id" uuid,
  ADD COLUMN IF NOT EXISTS "inventory_class" varchar(24) NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS "delivery_mode" varchar(20) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "traffic_risk_status" varchar(24) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "financial_eligibility" varchar(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "auction_decision_id" uuid,
  ADD COLUMN IF NOT EXISTS "opportunity_reservation_id" uuid,
  ADD COLUMN IF NOT EXISTS "policy_version" varchar(32) NOT NULL DEFAULT 'auction_v1';

-- 5. Extend ads_interactions with viewability persistence & GIVT/SIVT classification
ALTER TABLE "ads_interactions"
  ADD COLUMN IF NOT EXISTS "event_id" uuid,
  ADD COLUMN IF NOT EXISTS "website_id" uuid,
  ADD COLUMN IF NOT EXISTS "slot_id" uuid,
  ADD COLUMN IF NOT EXISTS "visible_ratio" varchar(16),
  ADD COLUMN IF NOT EXISTS "duration_ms" integer,
  ADD COLUMN IF NOT EXISTS "measurable" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "assessment_status" varchar(24) NOT NULL DEFAULT 'provisional',
  ADD COLUMN IF NOT EXISTS "ivt_category" varchar(20) NOT NULL DEFAULT 'unclassified',
  ADD COLUMN IF NOT EXISTS "financial_eligibility" varchar(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "keyed_ip_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "key_id" varchar(32);

-- 6. Create ads_auction_decisions (immutable tamper-evident auction decision ledger)
CREATE TABLE IF NOT EXISTS "ads_auction_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL UNIQUE,
  "serve_id" uuid,
  "promoter_id" uuid REFERENCES "ads_promoters"("id") ON DELETE SET NULL,
  "website_id" uuid REFERENCES "ads_promoter_websites"("id") ON DELETE SET NULL,
  "slot_id" uuid REFERENCES "adstation_slots"("id") ON DELETE SET NULL,
  "slot_tag_id" varchar(64) NOT NULL,
  "inventory_class" varchar(24) NOT NULL DEFAULT 'house',
  "delivery_mode" varchar(20) NOT NULL DEFAULT 'normal',
  "traffic_risk_status" varchar(24) NOT NULL DEFAULT 'normal',
  "financial_eligibility" varchar(24) NOT NULL DEFAULT 'invalid',
  "policy_version" varchar(32) NOT NULL DEFAULT 'auction_v1',
  "bidder_grouping_mode" varchar(24) NOT NULL DEFAULT 'advertiser',
  "tie_seed" varchar(64) NOT NULL,
  "candidate_count" integer NOT NULL DEFAULT 0,
  "eligible_group_count" integer NOT NULL DEFAULT 0,
  "evaluated_candidates" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "excluded_candidates" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "winner_campaign_id" uuid REFERENCES "ads_campaigns"("id") ON DELETE SET NULL,
  "winner_creative_id" uuid REFERENCES "ads_creatives"("id") ON DELETE SET NULL,
  "runner_up_campaign_id" uuid REFERENCES "ads_campaigns"("id") ON DELETE SET NULL,
  "pricing_model" varchar(20) NOT NULL DEFAULT 'cpm',
  "clearing_price_micros" bigint NOT NULL DEFAULT 0,
  "billing_price_nanos" bigint NOT NULL DEFAULT 0,
  "opportunity_reservation_id" uuid,
  "stage_timings_ms" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "previous_hash" varchar(64),
  "record_hash" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_auction_decisions_slot_id_idx" ON "ads_auction_decisions" ("slot_id");
CREATE INDEX IF NOT EXISTS "ads_auction_decisions_website_id_idx" ON "ads_auction_decisions" ("website_id");
CREATE INDEX IF NOT EXISTS "ads_auction_decisions_winner_campaign_idx" ON "ads_auction_decisions" ("winner_campaign_id");
CREATE INDEX IF NOT EXISTS "ads_auction_decisions_created_at_idx" ON "ads_auction_decisions" ("created_at");

-- 7. Create ads_opportunity_reservations (per-opportunity funded exposure reservations)
CREATE TABLE IF NOT EXISTS "ads_opportunity_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "opportunity_id" uuid NOT NULL UNIQUE,
  "campaign_id" uuid NOT NULL REFERENCES "ads_campaigns"("id") ON DELETE CASCADE,
  "escrow_id" uuid REFERENCES "ads_campaign_escrows"("id") ON DELETE SET NULL,
  "serve_id" uuid,
  "pricing_model" varchar(20) NOT NULL DEFAULT 'cpm',
  "reserved_nanos" bigint NOT NULL DEFAULT 0,
  "reserved_usd_cents_ceiling" integer NOT NULL DEFAULT 0,
  "state" varchar(20) NOT NULL DEFAULT 'HELD',
  "is_simulated" boolean NOT NULL DEFAULT false,
  "expires_at" timestamptz NOT NULL,
  "claimed_at" timestamptz,
  "released_at" timestamptz,
  "release_reason" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_opp_res_campaign_state_idx" ON "ads_opportunity_reservations" ("campaign_id", "state");
CREATE INDEX IF NOT EXISTS "ads_opp_res_expires_at_idx" ON "ads_opportunity_reservations" ("expires_at");
CREATE INDEX IF NOT EXISTS "ads_opp_res_serve_id_idx" ON "ads_opportunity_reservations" ("serve_id");

-- 8. Create ads_traffic_controls & ads_supply_state_history
CREATE TABLE IF NOT EXISTS "ads_traffic_controls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_scope" varchar(24) NOT NULL,
  "target_id" uuid NOT NULL,
  "action" varchar(40) NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "reason_code" varchar(64) NOT NULL,
  "internal_note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_traffic_controls_target_idx" ON "ads_traffic_controls" ("target_scope", "target_id", "is_active");

CREATE TABLE IF NOT EXISTS "ads_supply_state_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" varchar(24) NOT NULL,
  "entity_id" uuid NOT NULL,
  "dimension" varchar(32) NOT NULL,
  "from_state" varchar(32),
  "to_state" varchar(32) NOT NULL,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "actor_role" varchar(32) NOT NULL DEFAULT 'system',
  "reason" text,
  "request_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_supply_state_history_entity_idx" ON "ads_supply_state_history" ("entity_type", "entity_id", "created_at");

