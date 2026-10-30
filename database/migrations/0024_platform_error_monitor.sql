-- Migration 0024: Platform Error Monitor in Auth and Email Notifications (PLAN-0045)
-- Additive schema for sanitized error groups, sampled occurrences, durable outbox tasks, and source coverage.

CREATE TABLE IF NOT EXISTS "error_monitor_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "environment" varchar(32) DEFAULT 'staging' NOT NULL,
  "service" varchar(64) NOT NULL,
  "source" varchar(24) DEFAULT 'server' NOT NULL,
  "http_method" varchar(16) NOT NULL,
  "normalized_route" varchar(255) NOT NULL,
  "status_code" integer NOT NULL,
  "severity" varchar(16) DEFAULT 'error' NOT NULL,
  "error_category" varchar(80) NOT NULL,
  "safe_summary" varchar(320) NOT NULL,
  "is_financial_route" boolean DEFAULT false NOT NULL,
  "financial_category" varchar(64),
  "email_eligibility" varchar(32) NOT NULL,
  "exclusion_reason" varchar(64),
  "notification_state" varchar(32) DEFAULT 'excluded_by_policy' NOT NULL,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "sampled_occurrence_count" integer DEFAULT 1 NOT NULL,
  "window_started_at" timestamp with time zone,
  "window_ends_at" timestamp with time zone,
  "window_suppressed_count" integer DEFAULT 0 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_request_id" varchar(64),
  "railway_log_url" varchar(512),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "error_monitor_groups_env_fingerprint_uq"
  ON "error_monitor_groups" ("environment", "fingerprint");
CREATE INDEX IF NOT EXISTS "error_monitor_groups_service_last_seen_idx"
  ON "error_monitor_groups" ("service", "last_seen_at");
CREATE INDEX IF NOT EXISTS "error_monitor_groups_status_last_seen_idx"
  ON "error_monitor_groups" ("status_code", "last_seen_at");
CREATE INDEX IF NOT EXISTS "error_monitor_groups_email_state_idx"
  ON "error_monitor_groups" ("email_eligibility", "notification_state");

CREATE TABLE IF NOT EXISTS "error_monitor_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "error_monitor_groups"("id") ON DELETE CASCADE,
  "request_id" varchar(64) NOT NULL,
  "correlation_id" varchar(64),
  "environment" varchar(32) NOT NULL,
  "service" varchar(64) NOT NULL,
  "deployment_id" varchar(96),
  "source" varchar(24) DEFAULT 'server' NOT NULL,
  "http_method" varchar(16) NOT NULL,
  "normalized_route" varchar(255) NOT NULL,
  "status_code" integer NOT NULL,
  "error_category" varchar(80) NOT NULL,
  "safe_summary" varchar(320) NOT NULL,
  "upstream_service" varchar(64),
  "upstream_status_code" integer,
  "actor_user_id" uuid,
  "device_type" varchar(32),
  "country_code" varchar(8),
  "sanitized_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "railway_log_url" varchar(512),
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "error_monitor_occurrences_group_occurred_idx"
  ON "error_monitor_occurrences" ("group_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "error_monitor_occurrences_request_id_idx"
  ON "error_monitor_occurrences" ("request_id");
CREATE INDEX IF NOT EXISTS "error_monitor_occurrences_correlation_id_idx"
  ON "error_monitor_occurrences" ("correlation_id");

CREATE TABLE IF NOT EXISTS "error_monitor_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "error_monitor_groups"("id") ON DELETE CASCADE,
  "dedupe_key" varchar(140) NOT NULL,
  "kind" varchar(32) DEFAULT 'initial' NOT NULL,
  "environment" varchar(32) NOT NULL,
  "recipients" jsonb NOT NULL,
  "subject" varchar(255) NOT NULL,
  "html_body" text NOT NULL,
  "text_body" text NOT NULL,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "window_ends_at" timestamp with time zone NOT NULL,
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 4 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" varchar(80),
  "lease_expires_at" timestamp with time zone,
  "provider_message_id" varchar(160),
  "last_error" varchar(320),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "error_monitor_outbox_dedupe_key_uq"
  ON "error_monitor_outbox" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "error_monitor_outbox_status_next_attempt_idx"
  ON "error_monitor_outbox" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "error_monitor_outbox_group_id_idx"
  ON "error_monitor_outbox" ("group_id");

CREATE TABLE IF NOT EXISTS "error_monitor_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service" varchar(64) NOT NULL,
  "environment" varchar(32) DEFAULT 'staging' NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "source_type" varchar(24) DEFAULT 'server' NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "capture_enabled" boolean DEFAULT true NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "last_event_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "error_monitor_sources_env_service_uq"
  ON "error_monitor_sources" ("environment", "service");
