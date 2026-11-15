-- PLAN-0114: In-Process Distributed Cron Scheduler and Financial Audits
-- Durable job state, PostgreSQL renewable leases with fencing tokens,
-- recovery checkpoints, deferred audit windows, and immutable execution history.

CREATE TABLE IF NOT EXISTS "ads_cron_job_state" (
  "job_key" varchar(64) PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "schedule" varchar(64) NOT NULL,
  "timezone" varchar(32) NOT NULL DEFAULT 'UTC',
  "mode" varchar(24) NOT NULL DEFAULT 'REPORT_ONLY',
  "priority" integer NOT NULL DEFAULT 10,
  "is_heavy" boolean NOT NULL DEFAULT true,
  "last_attempted_run_at" timestamp with time zone,
  "last_successful_run_at" timestamp with time zone,
  "next_expected_run_at" timestamp with time zone,
  "lease_owner" varchar(128),
  "lease_expires_at" timestamp with time zone,
  "fencing_token" bigint NOT NULL DEFAULT 0,
  "last_completed_checkpoint" jsonb,
  "deferred_windows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_failure_reason" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ads_cron_job_state_lease_idx"
  ON "ads_cron_job_state" ("lease_expires_at");

CREATE INDEX IF NOT EXISTS "ads_cron_job_state_heavy_idx"
  ON "ads_cron_job_state" ("is_heavy", "lease_expires_at");

CREATE TABLE IF NOT EXISTS "ads_cron_job_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_key" varchar(64) NOT NULL REFERENCES "ads_cron_job_state"("job_key") ON DELETE CASCADE,
  "fencing_token" bigint NOT NULL DEFAULT 0,
  "trigger_time" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "duration_ms" integer,
  "instance_id" varchar(128) NOT NULL,
  "mode" varchar(24) NOT NULL DEFAULT 'REPORT_ONLY',
  "status" varchar(32) NOT NULL,
  "processed_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "deferred_count" integer NOT NULL DEFAULT 0,
  "checkpoint" jsonb,
  "summary" jsonb,
  "error_diagnostics" text
);

CREATE INDEX IF NOT EXISTS "ads_cron_job_runs_job_started_idx"
  ON "ads_cron_job_runs" ("job_key", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "ads_cron_job_runs_status_started_idx"
  ON "ads_cron_job_runs" ("status", "started_at" DESC);

