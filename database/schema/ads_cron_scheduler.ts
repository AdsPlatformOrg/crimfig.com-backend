import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  bigint,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * ads_cron_job_state
 *
 * Durable state, PostgreSQL distributed lease ownership, fencing token,
 * recovery checkpoints, and deferred windows for each registered in-process cron job (PLAN-0114).
 */
export const adsCronJobState = pgTable(
  'ads_cron_job_state',
  {
    jobKey: varchar('job_key', { length: 64 }).primaryKey(),
    enabled: boolean('enabled').notNull().default(true),
    schedule: varchar('schedule', { length: 64 }).notNull(),
    timezone: varchar('timezone', { length: 32 }).notNull().default('UTC'),
    mode: varchar('mode', { length: 24 }).notNull().default('REPORT_ONLY'), // 'ACTIVE' | 'REPORT_ONLY'
    priority: integer('priority').notNull().default(10),
    isHeavy: boolean('is_heavy').notNull().default(true),

    lastAttemptedRunAt: timestamp('last_attempted_run_at', { withTimezone: true }),
    lastSuccessfulRunAt: timestamp('last_successful_run_at', { withTimezone: true }),
    nextExpectedRunAt: timestamp('next_expected_run_at', { withTimezone: true }),

    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull().default(0),

    lastCompletedCheckpoint: jsonb('last_completed_checkpoint'),
    deferredWindows: jsonb('deferred_windows').notNull().default([]),

    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastFailureReason: text('last_failure_reason'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_cron_job_state_lease_idx').on(t.leaseExpiresAt),
    index('ads_cron_job_state_heavy_idx').on(t.isHeavy, t.leaseExpiresAt),
  ],
);

export type AdsCronJobState = typeof adsCronJobState.$inferSelect;
export type NewAdsCronJobState = typeof adsCronJobState.$inferInsert;

/**
 * ads_cron_job_runs
 *
 * Immutable execution history for in-process scheduled jobs (PLAN-0114).
 */
export const adsCronJobRuns = pgTable(
  'ads_cron_job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobKey: varchar('job_key', { length: 64 })
      .notNull()
      .references(() => adsCronJobState.jobKey, { onDelete: 'cascade' }),
    fencingToken: bigint('fencing_token', { mode: 'number' }).notNull().default(0),
    triggerTime: timestamp('trigger_time', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    instanceId: varchar('instance_id', { length: 128 }).notNull(),
    mode: varchar('mode', { length: 24 }).notNull().default('REPORT_ONLY'),
    status: varchar('status', { length: 32 }).notNull(), // 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED_LOCKED' | 'SKIPPED_DISABLED' | 'DEFERRED_CAPACITY'
    processedCount: integer('processed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    deferredCount: integer('deferred_count').notNull().default(0),
    checkpoint: jsonb('checkpoint'),
    summary: jsonb('summary'),
    errorDiagnostics: text('error_diagnostics'),
  },
  (t) => [
    index('ads_cron_job_runs_job_started_idx').on(t.jobKey, t.startedAt),
    index('ads_cron_job_runs_status_started_idx').on(t.status, t.startedAt),
  ],
);

export type AdsCronJobRun = typeof adsCronJobRuns.$inferSelect;
export type NewAdsCronJobRun = typeof adsCronJobRuns.$inferInsert;

