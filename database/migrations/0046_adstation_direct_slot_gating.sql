-- PLAN-0115: AdStation Direct Ad Slot manual review & revision-bound LIVE gating
ALTER TABLE "adstation_slots"
  ADD COLUMN IF NOT EXISTS "manual_review_status" varchar(24) NOT NULL DEFAULT 'not_submitted',
  ADD COLUMN IF NOT EXISTS "approved_revision" integer,
  ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reviewed_by" uuid,
  ADD COLUMN IF NOT EXISTS "review_reason" text;

CREATE INDEX IF NOT EXISTS "adstation_slots_manual_review_status_idx"
  ON "adstation_slots" ("manual_review_status");

