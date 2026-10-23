ALTER TABLE "ads_interactions" ADD COLUMN "verification_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "ads_settlement_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "interaction_id" uuid NOT NULL UNIQUE REFERENCES "ads_interactions"("id") ON DELETE RESTRICT,
  "serve_id" uuid NOT NULL UNIQUE REFERENCES "ads_serves"("id") ON DELETE RESTRICT,
  "escrow_id" uuid NOT NULL REFERENCES "ads_campaign_escrows"("id") ON DELETE RESTRICT,
  "allocated_usd_cents" bigint NOT NULL,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE RESTRICT,
  "batch_id" uuid NOT NULL REFERENCES "ads_settlement_batches"("id") ON DELETE RESTRICT,
  "price_nanos" bigint NOT NULL CHECK ("price_nanos" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "ads_settlement_carries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "escrow_id" uuid NOT NULL REFERENCES "ads_campaign_escrows"("id") ON DELETE RESTRICT,
  "allocated_usd_cents" bigint NOT NULL,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE RESTRICT,
  "carry_nanos" bigint NOT NULL DEFAULT 0 CHECK ("carry_nanos" >= 0 AND "carry_nanos" < 10000000),
  "billed_usd_cents" integer NOT NULL DEFAULT 0 CHECK ("billed_usd_cents" >= 0),
  "publisher_usd_cents" integer NOT NULL DEFAULT 0 CHECK ("publisher_usd_cents" >= 0),
  "commission_pool_usd_cents" integer NOT NULL DEFAULT 0 CHECK ("commission_pool_usd_cents" >= 0),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ads_settlement_carry_generation_unique" UNIQUE ("escrow_id", "allocated_usd_cents", "promoter_id")
);
