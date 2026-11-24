-- Non-billable visitor sentiment ratings for served adverts.
-- Stored separately from ads_serves because ads_serves is append-only (reject_ad_evidence_mutation).

CREATE TABLE IF NOT EXISTS "ads_serve_ratings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "serve_id" uuid NOT NULL REFERENCES "ads_serves"("id") ON DELETE CASCADE,
  "rating" varchar(16) NOT NULL CHECK ("rating" IN ('love', 'like', 'dislike')),
  "event_id" uuid NOT NULL,
  "occurred_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ads_serve_ratings_serve_id_unique" UNIQUE ("serve_id")
);
