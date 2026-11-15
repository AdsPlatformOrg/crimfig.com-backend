import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import {
  type CronJobDefinition,
  type CronJobMode,
  type DeferredAuditWindow,
  CronLeaseLostError,
} from './cron-job-registry';

export type AcquireLeaseResult =
  | {
      outcome: 'ACQUIRED';
      runId: string;
      fencingToken: number;
      startedAt: Date;
      leaseExpiresAt: Date;
      lastCheckpoint: Record<string, unknown> | null;
      deferredWindows: DeferredAuditWindow[];
    }
  | {
      outcome: 'SKIPPED_LOCKED';
      runId: string;
      currentOwner: string | null;
      leaseExpiresAt: string | null;
    }
  | {
      outcome: 'DEFERRED_CAPACITY';
      runId: string;
      activeHeavyJobKeys: string[];
    };

@Injectable()
export class CronJobStateRepository {
  private schemaEnsured = false;

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    await this.db.execute(sql`
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
      )
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "ads_cron_job_state_lease_idx"
        ON "ads_cron_job_state" ("lease_expires_at")
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "ads_cron_job_state_heavy_idx"
        ON "ads_cron_job_state" ("is_heavy", "lease_expires_at")
    `);
    await this.db.execute(sql`
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
      )
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "ads_cron_job_runs_job_started_idx"
        ON "ads_cron_job_runs" ("job_key", "started_at" DESC)
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "ads_cron_job_runs_status_started_idx"
        ON "ads_cron_job_runs" ("status", "started_at" DESC)
    `);
    this.schemaEnsured = true;
  }

  async seedRegisteredJobs(
    definitions: readonly CronJobDefinition[],
    resolveEnabled: (jobKey: string) => boolean,
    resolveMode: (jobKey: string) => CronJobMode,
    computeNextExpectedRun: (jobKey: string) => Date,
  ): Promise<void> {
    await this.ensureSchema();
    for (const def of definitions) {
      const enabled = resolveEnabled(def.jobKey);
      const mode = resolveMode(def.jobKey);
      const nextExpected = computeNextExpectedRun(def.jobKey).toISOString();
      await this.db.execute(sql`
        INSERT INTO ads_cron_job_state (
          job_key, enabled, schedule, timezone, mode, priority, is_heavy, next_expected_run_at, updated_at
        )
        VALUES (
          ${def.jobKey},
          ${enabled},
          ${def.schedule},
          ${def.timezone},
          ${mode},
          ${def.priority},
          ${def.isHeavy},
          ${nextExpected}::timestamptz,
          clock_timestamp()
        )
        ON CONFLICT (job_key) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          schedule = EXCLUDED.schedule,
          timezone = EXCLUDED.timezone,
          mode = EXCLUDED.mode,
          priority = EXCLUDED.priority,
          is_heavy = EXCLUDED.is_heavy,
          next_expected_run_at = COALESCE(ads_cron_job_state.next_expected_run_at, EXCLUDED.next_expected_run_at),
          updated_at = clock_timestamp()
      `);
    }
  }

  async recordDisabledSkip(params: {
    jobKey: string;
    instanceId: string;
    mode: CronJobMode;
    triggerTime: Date;
    reason: string;
  }): Promise<string> {
    await this.ensureSchema();
    const res = await this.db.execute<{ id: string }>(sql`
      INSERT INTO ads_cron_job_runs (
        job_key, fencing_token, trigger_time, started_at, completed_at, duration_ms,
        instance_id, mode, status, summary
      )
      VALUES (
        ${params.jobKey},
        0,
        ${params.triggerTime.toISOString()}::timestamptz,
        clock_timestamp(),
        clock_timestamp(),
        0,
        ${params.instanceId},
        ${params.mode},
        'SKIPPED_DISABLED',
        ${JSON.stringify({ reason: params.reason })}::jsonb
      )
      RETURNING id
    `);
    return ((res as any).rows ?? res)[0].id;
  }

  async tryAcquireLease(params: {
    definition: CronJobDefinition;
    instanceId: string;
    mode: CronJobMode;
    triggerTime: Date;
    nextExpectedRunAt: Date;
    maxConcurrentHeavyJobs: number;
    deferralWindow?: { lower: string; upper: string };
  }): Promise<AcquireLeaseResult> {
    await this.ensureSchema();
    const { definition, instanceId, mode, triggerTime, nextExpectedRunAt, maxConcurrentHeavyJobs } = params;

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ads:cron-scheduler-lease:v1'))`);

      // Ensure job state row exists
      await tx.execute(sql`
        INSERT INTO ads_cron_job_state (
          job_key, enabled, schedule, timezone, mode, priority, is_heavy, next_expected_run_at, updated_at
        )
        VALUES (
          ${definition.jobKey},
          true,
          ${definition.schedule},
          ${definition.timezone},
          ${mode},
          ${definition.priority},
          ${definition.isHeavy},
          ${nextExpectedRunAt.toISOString()}::timestamptz,
          clock_timestamp()
        )
        ON CONFLICT (job_key) DO NOTHING
      `);

      const currentRes = await tx.execute<{
        job_key: string;
        lease_owner: string | null;
        lease_expires_at: string | null;
        is_locked: boolean;
        fencing_token: string | number;
        last_completed_checkpoint: Record<string, unknown> | null;
        deferred_windows: DeferredAuditWindow[] | null;
      }>(sql`
        SELECT
          job_key,
          lease_owner,
          lease_expires_at::text AS lease_expires_at,
          (lease_owner IS NOT NULL AND lease_expires_at > clock_timestamp()) AS is_locked,
          fencing_token,
          last_completed_checkpoint,
          deferred_windows
        FROM ads_cron_job_state
        WHERE job_key = ${definition.jobKey}
        FOR UPDATE
      `);

      const current = ((currentRes as any).rows ?? currentRes)[0];
      if (current?.is_locked) {
        const skipRes = await tx.execute<{ id: string }>(sql`
          INSERT INTO ads_cron_job_runs (
            job_key, fencing_token, trigger_time, started_at, completed_at, duration_ms,
            instance_id, mode, status, summary
          )
          VALUES (
            ${definition.jobKey},
            ${Number(current.fencing_token ?? 0)},
            ${triggerTime.toISOString()}::timestamptz,
            clock_timestamp(),
            clock_timestamp(),
            0,
            ${instanceId},
            ${mode},
            'SKIPPED_LOCKED',
            ${JSON.stringify({
              currentOwner: current.lease_owner,
              leaseExpiresAt: current.lease_expires_at,
            })}::jsonb
          )
          RETURNING id
        `);
        const runId = ((skipRes as any).rows ?? skipRes)[0].id;
        return {
          outcome: 'SKIPPED_LOCKED',
          runId,
          currentOwner: current.lease_owner,
          leaseExpiresAt: current.lease_expires_at,
        };
      }

      // Check global heavy job concurrency limit for lower-priority jobs (priority > 1)
      if (definition.isHeavy && definition.priority > 1) {
        const heavyRes = await tx.execute<{ job_key: string }>(sql`
          SELECT job_key
          FROM ads_cron_job_state
          WHERE is_heavy = true
            AND job_key <> ${definition.jobKey}
            AND lease_owner IS NOT NULL
            AND lease_expires_at > clock_timestamp()
          ORDER BY priority ASC, job_key ASC
        `);
        const activeHeavyRows = ((heavyRes as any).rows ?? heavyRes) as Array<{ job_key: string }>;
        if (activeHeavyRows.length >= maxConcurrentHeavyJobs) {
          const activeHeavyJobKeys = activeHeavyRows.map((r) => r.job_key);
          const existingDeferred = Array.isArray(current?.deferred_windows)
            ? [...current.deferred_windows]
            : [];
          const windowToDefer: DeferredAuditWindow = {
            lower:
              params.deferralWindow?.lower ??
              new Date(triggerTime.getTime() - 6 * 3_600_000).toISOString(),
            upper: params.deferralWindow?.upper ?? triggerTime.toISOString(),
            deferredAt: triggerTime.toISOString(),
            reason: `HEAVY_CAPACITY_OCCUPIED:${activeHeavyJobKeys.join(',')}`,
          };
          const duplicate = existingDeferred.some(
            (w) => w.lower === windowToDefer.lower && w.upper === windowToDefer.upper,
          );
          if (!duplicate && existingDeferred.length < 100) {
            existingDeferred.push(windowToDefer);
          }

          await tx.execute(sql`
            UPDATE ads_cron_job_state
            SET deferred_windows = ${JSON.stringify(existingDeferred)}::jsonb,
                last_attempted_run_at = clock_timestamp(),
                next_expected_run_at = ${nextExpectedRunAt.toISOString()}::timestamptz,
                updated_at = clock_timestamp()
            WHERE job_key = ${definition.jobKey}
          `);

          const deferRunRes = await tx.execute<{ id: string }>(sql`
            INSERT INTO ads_cron_job_runs (
              job_key, fencing_token, trigger_time, started_at, completed_at, duration_ms,
              instance_id, mode, status, deferred_count, summary
            )
            VALUES (
              ${definition.jobKey},
              ${Number(current?.fencing_token ?? 0)},
              ${triggerTime.toISOString()}::timestamptz,
              clock_timestamp(),
              clock_timestamp(),
              0,
              ${instanceId},
              ${mode},
              'DEFERRED_CAPACITY',
              ${existingDeferred.length},
              ${JSON.stringify({
                activeHeavyJobKeys,
                deferredWindow: windowToDefer,
              })}::jsonb
            )
            RETURNING id
          `);
          const runId = ((deferRunRes as any).rows ?? deferRunRes)[0].id;
          return {
            outcome: 'DEFERRED_CAPACITY',
            runId,
            activeHeavyJobKeys,
          };
        }
      }

      // Atomically acquire the lease using database clock_timestamp()
      const acquireRes = await tx.execute<{
        fencing_token: string | number;
        started_at: string;
        lease_expires_at: string;
        last_completed_checkpoint: Record<string, unknown> | null;
        deferred_windows: DeferredAuditWindow[] | null;
      }>(sql`
        UPDATE ads_cron_job_state
        SET lease_owner = ${instanceId},
            lease_expires_at = clock_timestamp() + (${String(definition.leaseTtlMs)} || ' milliseconds')::interval,
            fencing_token = fencing_token + 1,
            mode = ${mode},
            last_attempted_run_at = clock_timestamp(),
            next_expected_run_at = ${nextExpectedRunAt.toISOString()}::timestamptz,
            updated_at = clock_timestamp()
        WHERE job_key = ${definition.jobKey}
          AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
        RETURNING
          fencing_token,
          last_attempted_run_at::text AS started_at,
          lease_expires_at::text AS lease_expires_at,
          last_completed_checkpoint,
          deferred_windows
      `);

      const acquired = ((acquireRes as any).rows ?? acquireRes)[0];
      if (!acquired) {
        const fallbackRes = await tx.execute<{ id: string }>(sql`
          INSERT INTO ads_cron_job_runs (
            job_key, fencing_token, trigger_time, started_at, completed_at, duration_ms,
            instance_id, mode, status
          )
          VALUES (
            ${definition.jobKey},
            0,
            ${triggerTime.toISOString()}::timestamptz,
            clock_timestamp(),
            clock_timestamp(),
            0,
            ${instanceId},
            ${mode},
            'SKIPPED_LOCKED'
          )
          RETURNING id
        `);
        return {
          outcome: 'SKIPPED_LOCKED',
          runId: ((fallbackRes as any).rows ?? fallbackRes)[0].id,
          currentOwner: null,
          leaseExpiresAt: null,
        };
      }

      const fencingToken = Number(acquired.fencing_token);
      const runRes = await tx.execute<{ id: string }>(sql`
        INSERT INTO ads_cron_job_runs (
          job_key, fencing_token, trigger_time, started_at,
          instance_id, mode, status
        )
        VALUES (
          ${definition.jobKey},
          ${fencingToken},
          ${triggerTime.toISOString()}::timestamptz,
          clock_timestamp(),
          ${instanceId},
          ${mode},
          'RUNNING'
        )
        RETURNING id
      `);
      const runId = ((runRes as any).rows ?? runRes)[0].id;

      return {
        outcome: 'ACQUIRED',
        runId,
        fencingToken,
        startedAt: new Date(acquired.started_at),
        leaseExpiresAt: new Date(acquired.lease_expires_at),
        lastCheckpoint: acquired.last_completed_checkpoint ?? null,
        deferredWindows: Array.isArray(acquired.deferred_windows) ? acquired.deferred_windows : [],
      };
    });
  }

  async renewLease(
    jobKey: string,
    instanceId: string,
    fencingToken: number,
    leaseTtlMs: number,
  ): Promise<boolean> {
    const res = await this.db.execute<{ fencing_token: string | number }>(sql`
      UPDATE ads_cron_job_state
      SET lease_expires_at = clock_timestamp() + (${String(leaseTtlMs)} || ' milliseconds')::interval,
          updated_at = clock_timestamp()
      WHERE job_key = ${jobKey}
        AND lease_owner = ${instanceId}
        AND fencing_token = ${fencingToken}
        AND lease_expires_at > clock_timestamp()
      RETURNING fencing_token
    `);
    const rows = ((res as any).rows ?? res) as Array<{ fencing_token: string | number }>;
    return rows.length > 0;
  }

  async verifyLeaseOwnership(
    jobKey: string,
    instanceId: string,
    fencingToken: number,
  ): Promise<boolean> {
    const res = await this.db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok
      FROM ads_cron_job_state
      WHERE job_key = ${jobKey}
        AND lease_owner = ${instanceId}
        AND fencing_token = ${fencingToken}
        AND lease_expires_at > clock_timestamp()
      LIMIT 1
    `);
    const rows = ((res as any).rows ?? res) as Array<{ ok: number }>;
    return rows.length > 0;
  }

  async saveCheckpoint(params: {
    jobKey: string;
    instanceId: string;
    fencingToken: number;
    runId: string;
    checkpoint: Record<string, unknown>;
  }): Promise<void> {
    const res = await this.db.execute<{ job_key: string }>(sql`
      UPDATE ads_cron_job_state
      SET last_completed_checkpoint = ${JSON.stringify(params.checkpoint)}::jsonb,
          updated_at = clock_timestamp()
      WHERE job_key = ${params.jobKey}
        AND lease_owner = ${params.instanceId}
        AND fencing_token = ${params.fencingToken}
        AND lease_expires_at > clock_timestamp()
      RETURNING job_key
    `);
    const rows = ((res as any).rows ?? res) as Array<{ job_key: string }>;
    if (rows.length === 0) {
      throw new CronLeaseLostError(params.jobKey, params.instanceId, params.fencingToken);
    }

    await this.db.execute(sql`
      UPDATE ads_cron_job_runs
      SET checkpoint = ${JSON.stringify(params.checkpoint)}::jsonb
      WHERE id = ${params.runId}::uuid
        AND fencing_token = ${params.fencingToken}
    `);
  }

  async completeRun(params: {
    jobKey: string;
    instanceId: string;
    fencingToken: number;
    runId: string;
    startedAt: Date;
    nextExpectedRunAt: Date;
    processedCount: number;
    failedCount: number;
    deferredCount: number;
    checkpoint?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    remainingDeferredWindows?: DeferredAuditWindow[];
  }): Promise<boolean> {
    const durationMs = Math.max(0, Date.now() - params.startedAt.getTime());
    const stateRes = await this.db.execute<{ job_key: string }>(sql`
      UPDATE ads_cron_job_state
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          last_successful_run_at = clock_timestamp(),
          next_expected_run_at = ${params.nextExpectedRunAt.toISOString()}::timestamptz,
          consecutive_failures = 0,
          last_failure_reason = NULL,
          last_completed_checkpoint = COALESCE(
            ${params.checkpoint ? JSON.stringify(params.checkpoint) : null}::jsonb,
            last_completed_checkpoint
          ),
          deferred_windows = ${JSON.stringify(params.remainingDeferredWindows ?? [])}::jsonb,
          updated_at = clock_timestamp()
      WHERE job_key = ${params.jobKey}
        AND lease_owner = ${params.instanceId}
        AND fencing_token = ${params.fencingToken}
      RETURNING job_key
    `);
    const updatedState = (((stateRes as any).rows ?? stateRes) as Array<{ job_key: string }>).length > 0;

    await this.db.execute(sql`
      UPDATE ads_cron_job_runs
      SET status = ${updatedState ? 'COMPLETED' : 'FAILED'},
          completed_at = clock_timestamp(),
          duration_ms = ${durationMs},
          processed_count = ${params.processedCount},
          failed_count = ${params.failedCount},
          deferred_count = ${params.deferredCount},
          checkpoint = COALESCE(
            ${params.checkpoint ? JSON.stringify(params.checkpoint) : null}::jsonb,
            checkpoint
          ),
          summary = ${params.summary ? JSON.stringify(params.summary) : null}::jsonb,
          error_diagnostics = ${updatedState ? null : 'Lease ownership lost before completion commit'}
      WHERE id = ${params.runId}::uuid
        AND fencing_token = ${params.fencingToken}
    `);

    return updatedState;
  }

  async failRun(params: {
    jobKey: string;
    instanceId: string;
    fencingToken: number;
    runId: string;
    startedAt: Date;
    nextExpectedRunAt: Date;
    errorDiagnostics: string;
    processedCount?: number;
    failedCount?: number;
    deferredCount?: number;
  }): Promise<void> {
    const durationMs = Math.max(0, Date.now() - params.startedAt.getTime());
    const boundedError = String(params.errorDiagnostics ?? 'Unknown error').slice(0, 2000);

    await this.db.execute(sql`
      UPDATE ads_cron_job_state
      SET lease_owner = CASE
            WHEN lease_owner = ${params.instanceId} AND fencing_token = ${params.fencingToken} THEN NULL
            ELSE lease_owner
          END,
          lease_expires_at = CASE
            WHEN lease_owner = ${params.instanceId} AND fencing_token = ${params.fencingToken} THEN NULL
            ELSE lease_expires_at
          END,
          next_expected_run_at = ${params.nextExpectedRunAt.toISOString()}::timestamptz,
          consecutive_failures = consecutive_failures + 1,
          last_failure_reason = ${boundedError},
          updated_at = clock_timestamp()
      WHERE job_key = ${params.jobKey}
        AND fencing_token = ${params.fencingToken}
    `);

    await this.db.execute(sql`
      UPDATE ads_cron_job_runs
      SET status = 'FAILED',
          completed_at = clock_timestamp(),
          duration_ms = ${durationMs},
          processed_count = ${params.processedCount ?? 0},
          failed_count = ${params.failedCount ?? 1},
          deferred_count = ${params.deferredCount ?? 0},
          error_diagnostics = ${boundedError}
      WHERE id = ${params.runId}::uuid
        AND fencing_token = ${params.fencingToken}
    `);
  }

  async releaseOwnedLeasesForInstance(instanceId: string): Promise<number> {
    if (!this.schemaEnsured) return 0;
    const res = await this.db.execute<{ job_key: string }>(sql`
      UPDATE ads_cron_job_state
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE lease_owner = ${instanceId}
      RETURNING job_key
    `);
    return (((res as any).rows ?? res) as Array<{ job_key: string }>).length;
  }

  async getMonitoringSnapshot(params: {
    masterEnabled: boolean;
    automaticFinancialCorrectionsEnabled: boolean;
    instanceId: string;
  }) {
    await this.ensureSchema();

    const stateRes = await this.db.execute<{
      job_key: string;
      enabled: boolean;
      schedule: string;
      timezone: string;
      mode: string;
      priority: number;
      is_heavy: boolean;
      last_attempted_run_at: string | null;
      last_successful_run_at: string | null;
      next_expected_run_at: string | null;
      lease_owner: string | null;
      lease_expires_at: string | null;
      is_currently_running: boolean;
      is_missed_schedule: boolean;
      is_stale_reporting: boolean;
      fencing_token: string | number;
      last_completed_checkpoint: Record<string, unknown> | null;
      deferred_windows: DeferredAuditWindow[] | null;
      consecutive_failures: number;
      last_failure_reason: string | null;
      updated_at: string;
    }>(sql`
      SELECT
        job_key,
        enabled,
        schedule,
        timezone,
        mode,
        priority,
        is_heavy,
        last_attempted_run_at::text AS last_attempted_run_at,
        last_successful_run_at::text AS last_successful_run_at,
        next_expected_run_at::text AS next_expected_run_at,
        lease_owner,
        lease_expires_at::text AS lease_expires_at,
        (lease_owner IS NOT NULL AND lease_expires_at > clock_timestamp()) AS is_currently_running,
        (enabled = true AND next_expected_run_at IS NOT NULL AND next_expected_run_at + interval '2 minutes' < clock_timestamp()) AS is_missed_schedule,
        (enabled = true AND last_successful_run_at IS NOT NULL AND last_successful_run_at + interval '24 hours' < clock_timestamp()) AS is_stale_reporting,
        fencing_token,
        last_completed_checkpoint,
        deferred_windows,
        consecutive_failures,
        last_failure_reason,
        updated_at::text AS updated_at
      FROM ads_cron_job_state
      ORDER BY priority ASC, job_key ASC
    `);

    const runsRes = await this.db.execute<{
      id: string;
      job_key: string;
      fencing_token: string | number;
      trigger_time: string;
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      instance_id: string;
      mode: string;
      status: string;
      processed_count: number;
      failed_count: number;
      deferred_count: number;
      error_diagnostics: string | null;
    }>(sql`
      SELECT
        id,
        job_key,
        fencing_token,
        trigger_time::text AS trigger_time,
        started_at::text AS started_at,
        completed_at::text AS completed_at,
        duration_ms,
        instance_id,
        mode,
        status,
        processed_count,
        failed_count,
        deferred_count,
        error_diagnostics
      FROM ads_cron_job_runs
      ORDER BY started_at DESC
      LIMIT 50
    `);

    const backlogRes = await this.db.execute<{
      pending_cpc_claims: number;
      oldest_pending_claim_age_seconds: number | null;
      unassessed_paid_clicks: number;
    }>(sql`
      SELECT
        (
          SELECT count(*)::int
          FROM ads_opportunity_reservations
          WHERE NOT is_simulated
            AND pricing_model = 'cpc'
            AND state = 'CLAIMED'
            AND settled_at IS NULL
        ) AS pending_cpc_claims,
        (
          SELECT EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at)))::int
          FROM ads_opportunity_reservations
          WHERE NOT is_simulated
            AND pricing_model = 'cpc'
            AND state = 'CLAIMED'
            AND settled_at IS NULL
        ) AS oldest_pending_claim_age_seconds,
        (
          SELECT count(*)::int
          FROM ads_interactions e
          JOIN ads_serves s ON s.id = e.serve_id
          WHERE s.inventory_class = 'paid'
            AND e.type = 'click'
            AND e.is_valid = true
            AND e.financial_eligibility = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM ads_event_assessments a WHERE a.event_id = e.id
            )
        ) AS unassessed_paid_clicks
    `);

    const states = ((stateRes as any).rows ?? stateRes) as Array<any>;
    const recentRuns = ((runsRes as any).rows ?? runsRes) as Array<any>;
    const backlogRow = (((backlogRes as any).rows ?? backlogRes) as Array<any>)[0] ?? {
      pending_cpc_claims: 0,
      oldest_pending_claim_age_seconds: null,
      unassessed_paid_clicks: 0,
    };

    const recentErrors = recentRuns
      .filter((r) => r.status === 'FAILED' && r.error_diagnostics)
      .slice(0, 15)
      .map((r) => ({
        runId: r.id,
        jobKey: r.job_key,
        occurredAt: r.completed_at ?? r.started_at,
        instanceId: r.instance_id,
        errorDiagnostics: r.error_diagnostics,
      }));

    return {
      masterEnabled: params.masterEnabled,
      automaticFinancialCorrectionsEnabled: params.automaticFinancialCorrectionsEnabled,
      observerInstanceId: params.instanceId,
      checkedAt: new Date().toISOString(),
      backlog: {
        pendingCpcClaims: Number(backlogRow.pending_cpc_claims ?? 0),
        oldestPendingClaimAgeSeconds:
          backlogRow.oldest_pending_claim_age_seconds !== null &&
          backlogRow.oldest_pending_claim_age_seconds !== undefined
            ? Number(backlogRow.oldest_pending_claim_age_seconds)
            : null,
        unassessedPaidClicks: Number(backlogRow.unassessed_paid_clicks ?? 0),
      },
      jobs: states.map((s) => ({
        jobKey: s.job_key,
        enabled: Boolean(s.enabled) && params.masterEnabled,
        configuredEnabled: Boolean(s.enabled),
        schedule: s.schedule,
        timezone: s.timezone,
        mode: s.mode,
        priority: Number(s.priority),
        isHeavy: Boolean(s.is_heavy),
        currentExecutionStatus: s.is_currently_running
          ? 'RUNNING'
          : Number(s.consecutive_failures) > 0
            ? 'DEGRADED'
            : 'IDLE',
        leaseOwner: s.lease_owner,
        leaseExpiresAt: s.lease_expires_at,
        fencingToken: Number(s.fencing_token ?? 0),
        lastAttemptedRunAt: s.last_attempted_run_at,
        lastSuccessfulRunAt: s.last_successful_run_at,
        nextExpectedRunAt: s.next_expected_run_at,
        missedSchedule: Boolean(s.is_missed_schedule),
        staleReporting: Boolean(s.is_stale_reporting),
        consecutiveFailures: Number(s.consecutive_failures ?? 0),
        lastFailureReason: s.last_failure_reason,
        deferredWindowsCount: Array.isArray(s.deferred_windows) ? s.deferred_windows.length : 0,
        deferredWindows: Array.isArray(s.deferred_windows) ? s.deferred_windows : [],
        lastCompletedCheckpoint: s.last_completed_checkpoint ?? null,
      })),
      recentRuns: recentRuns.map((r) => ({
        runId: r.id,
        jobKey: r.job_key,
        fencingToken: Number(r.fencing_token ?? 0),
        triggerTime: r.trigger_time,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
        instanceId: r.instance_id,
        mode: r.mode,
        status: r.status,
        processedCount: Number(r.processed_count ?? 0),
        failedCount: Number(r.failed_count ?? 0),
        deferredCount: Number(r.deferred_count ?? 0),
        errorDiagnostics: r.error_diagnostics,
      })),
      recentErrors,
    };
  }
}

