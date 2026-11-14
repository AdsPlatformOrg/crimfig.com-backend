-- PLAN-0111: Publisher Traffic Quality & Coordinated Click Fraud Detection
-- Three-referrer origin-only telemetry, report-only publisher risk assessments,
-- bounded pre-settlement quarantine cohorts, and publisher appeals.

ALTER TABLE "ads_interactions"
  ADD COLUMN IF NOT EXISTS "initial_page_referrer_origin" text,
  ADD COLUMN IF NOT EXISTS "sdk_event_referrer_origin" text,
  ADD COLUMN IF NOT EXISTS "click_redirect_referrer_origin" text,
  ADD COLUMN IF NOT EXISTS "acquisition_source_class" varchar(32),
  ADD COLUMN IF NOT EXISTS "untrusted_utm_hint" varchar(128);

CREATE INDEX IF NOT EXISTS "ads_interactions_acq_source_idx"
  ON "ads_interactions" ("promoter_id", "acquisition_source_class", "created_at");

CREATE TABLE IF NOT EXISTS "ads_publisher_traffic_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE CASCADE,
  "website_id" uuid NOT NULL REFERENCES "ads_promoter_websites"("id") ON DELETE CASCADE,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "visitor_count" integer NOT NULL DEFAULT 0,
  "distinct_ip_count" integer NOT NULL DEFAULT 0,
  "click_count" integer NOT NULL DEFAULT 0,
  "click_to_visit_ratio" double precision NOT NULL DEFAULT 0,
  "high_signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "supporting_signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model_version" varchar(32) NOT NULL DEFAULT 'ptq-v1',
  "enforcement_mode" varchar(24) NOT NULL DEFAULT 'report_only',
  "disposition" varchar(24) NOT NULL DEFAULT 'eligible',
  "would_quarantine_if_enforced" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_pub_traffic_assess_promoter_idx"
  ON "ads_publisher_traffic_assessments" ("promoter_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "ads_click_quarantine_cohorts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id" uuid NOT NULL REFERENCES "ads_publisher_traffic_assessments"("id") ON DELETE CASCADE,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE CASCADE,
  "website_id" uuid NOT NULL REFERENCES "ads_promoter_websites"("id") ON DELETE CASCADE,
  "status" varchar(24) NOT NULL DEFAULT 'pending_review',
  "event_count" integer NOT NULL DEFAULT 0,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolution_note" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ads_publisher_traffic_appeals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promoter_id" uuid NOT NULL REFERENCES "ads_promoters"("id") ON DELETE CASCADE,
  "website_id" uuid REFERENCES "ads_promoter_websites"("id") ON DELETE SET NULL,
  "cohort_id" uuid REFERENCES "ads_click_quarantine_cohorts"("id") ON DELETE SET NULL,
  "explanation" text NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'submitted',
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "review_note" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

