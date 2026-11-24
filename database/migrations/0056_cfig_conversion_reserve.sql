-- Dedicated USD backing reserve pool for $cfig conversions and manual owner seed commitments (PLAN-0168).
CREATE TABLE IF NOT EXISTS "cfig_conversion_reserve" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD' UNIQUE,
  "available_cents" bigint NOT NULL DEFAULT 0 CHECK ("available_cents" >= 0),
  "reserved_cents" bigint NOT NULL DEFAULT 0 CHECK ("reserved_cents" >= 0),
  "spent_cents" bigint NOT NULL DEFAULT 0 CHECK ("spent_cents" >= 0),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
