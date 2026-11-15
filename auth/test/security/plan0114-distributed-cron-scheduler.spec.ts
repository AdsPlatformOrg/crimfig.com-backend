import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CronJobRegistry,
  CronLeaseLostError,
  type CronExecutionContext,
} from '../../../api/ads-api/src/modules/scheduling/cron-job-registry';
import { CronExecutionCoordinator } from '../../../api/ads-api/src/modules/scheduling/cron-execution-coordinator.service';
import { AdsCronSchedulerService } from '../../../api/ads-api/src/modules/scheduling/ads-cron-scheduler.service';
import { RollingFraudAuditJob } from '../../../api/ads-api/src/modules/scheduling/jobs/rolling-fraud-audit.job';
import { Day15AuditJob } from '../../../api/ads-api/src/modules/scheduling/jobs/day-15-audit.job';
import { Day30AuditJob } from '../../../api/ads-api/src/modules/scheduling/jobs/day-30-audit.job';
import { SchedulingMonitorController } from '../../../api/ads-api/src/modules/scheduling/scheduling-monitor.controller';

interface InMemoryJobState {
  jobKey: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  mode: string;
  priority: number;
  isHeavy: boolean;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  fencingToken: number;
  lastCompletedCheckpoint: Record<string, unknown> | null;
  deferredWindows: Array<{ lower: string; upper: string; deferredAt: string; reason: string }>;
  consecutiveFailures: number;
  lastFailureReason: string | null;
}

class FakeCronJobStateRepository {
  public readonly states = new Map<string, InMemoryJobState>();
  public readonly runs: Array<Record<string, any>> = [];
  private nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  async ensureSchema() {}

  async seedRegisteredJobs(definitions: any[], resolveEnabled: any, resolveMode: any) {
    for (const def of definitions) {
      if (!this.states.has(def.jobKey)) {
        this.states.set(def.jobKey, {
          jobKey: def.jobKey,
          enabled: resolveEnabled(def.jobKey),
          schedule: def.schedule,
          timezone: def.timezone,
          mode: resolveMode(def.jobKey),
          priority: def.priority,
          isHeavy: def.isHeavy,
          leaseOwner: null,
          leaseExpiresAtMs: null,
          fencingToken: 0,
          lastCompletedCheckpoint: null,
          deferredWindows: [],
          consecutiveFailures: 0,
          lastFailureReason: null,
        });
      }
    }
  }

  async tryAcquireLease(params: any) {
    const { definition, instanceId, mode, triggerTime, maxConcurrentHeavyJobs, deferralWindow } =
      params;
    const now = this.nowFn();
    let state = this.states.get(definition.jobKey);
    if (!state) {
      state = {
        jobKey: definition.jobKey,
        enabled: true,
        schedule: definition.schedule,
        timezone: definition.timezone,
        mode,
        priority: definition.priority,
        isHeavy: definition.isHeavy,
        leaseOwner: null,
        leaseExpiresAtMs: null,
        fencingToken: 0,
        lastCompletedCheckpoint: null,
        deferredWindows: [],
        consecutiveFailures: 0,
        lastFailureReason: null,
      };
      this.states.set(definition.jobKey, state);
    }

    const isLocked = state.leaseOwner !== null && (state.leaseExpiresAtMs ?? 0) > now;
    if (isLocked) {
      const runId = `run-skip-${this.runs.length + 1}`;
      this.runs.push({
        id: runId,
        jobKey: definition.jobKey,
        instanceId,
        status: 'SKIPPED_LOCKED',
        fencingToken: state.fencingToken,
      });
      return {
        outcome: 'SKIPPED_LOCKED' as const,
        runId,
        currentOwner: state.leaseOwner,
        leaseExpiresAt: new Date(state.leaseExpiresAtMs!).toISOString(),
      };
    }

    if (definition.isHeavy && definition.priority > 1) {
      const activeHeavy = Array.from(this.states.values()).filter(
        (s) =>
          s.isHeavy &&
          s.jobKey !== definition.jobKey &&
          s.leaseOwner !== null &&
          (s.leaseExpiresAtMs ?? 0) > now,
      );
      if (activeHeavy.length >= maxConcurrentHeavyJobs) {
        const activeHeavyJobKeys = activeHeavy.map((s) => s.jobKey);
        const win = {
          lower:
            deferralWindow?.lower ??
            new Date(triggerTime.getTime() - 6 * 3_600_000).toISOString(),
          upper: deferralWindow?.upper ?? triggerTime.toISOString(),
          deferredAt: triggerTime.toISOString(),
          reason: `HEAVY_CAPACITY_OCCUPIED:${activeHeavyJobKeys.join(',')}`,
        };
        state.deferredWindows.push(win);
        const runId = `run-defer-${this.runs.length + 1}`;
        this.runs.push({
          id: runId,
          jobKey: definition.jobKey,
          instanceId,
          status: 'DEFERRED_CAPACITY',
          deferredCount: state.deferredWindows.length,
        });
        return {
          outcome: 'DEFERRED_CAPACITY' as const,
          runId,
          activeHeavyJobKeys,
        };
      }
    }

    state.fencingToken += 1;
    state.leaseOwner = instanceId;
    state.leaseExpiresAtMs = now + definition.leaseTtlMs;
    state.mode = mode;

    const runId = `run-ok-${this.runs.length + 1}`;
    this.runs.push({
      id: runId,
      jobKey: definition.jobKey,
      instanceId,
      status: 'RUNNING',
      fencingToken: state.fencingToken,
    });

    return {
      outcome: 'ACQUIRED' as const,
      runId,
      fencingToken: state.fencingToken,
      startedAt: new Date(now),
      leaseExpiresAt: new Date(state.leaseExpiresAtMs!),
      lastCheckpoint: state.lastCompletedCheckpoint,
      deferredWindows: [...state.deferredWindows],
    };
  }

  async renewLease(
    jobKey: string,
    instanceId: string,
    fencingToken: number,
    leaseTtlMs: number,
  ): Promise<boolean> {
    const now = this.nowFn();
    const state = this.states.get(jobKey);
    if (
      !state ||
      state.leaseOwner !== instanceId ||
      state.fencingToken !== fencingToken ||
      (state.leaseExpiresAtMs ?? 0) <= now
    ) {
      return false;
    }
    state.leaseExpiresAtMs = now + leaseTtlMs;
    return true;
  }

  async verifyLeaseOwnership(
    jobKey: string,
    instanceId: string,
    fencingToken: number,
  ): Promise<boolean> {
    const now = this.nowFn();
    const state = this.states.get(jobKey);
    return Boolean(
      state &&
        state.leaseOwner === instanceId &&
        state.fencingToken === fencingToken &&
        (state.leaseExpiresAtMs ?? 0) > now,
    );
  }

  async saveCheckpoint(params: {
    jobKey: string;
    instanceId: string;
    fencingToken: number;
    runId: string;
    checkpoint: Record<string, unknown>;
  }): Promise<void> {
    const ok = await this.verifyLeaseOwnership(
      params.jobKey,
      params.instanceId,
      params.fencingToken,
    );
    if (!ok) {
      throw new CronLeaseLostError(params.jobKey, params.instanceId, params.fencingToken);
    }
    const state = this.states.get(params.jobKey)!;
    state.lastCompletedCheckpoint = params.checkpoint;
  }

  async completeRun(params: any): Promise<boolean> {
    const state = this.states.get(params.jobKey);
    if (
      !state ||
      state.leaseOwner !== params.instanceId ||
      state.fencingToken !== params.fencingToken
    ) {
      return false;
    }
    state.leaseOwner = null;
    state.leaseExpiresAtMs = null;
    state.consecutiveFailures = 0;
    state.lastFailureReason = null;
    if (params.checkpoint) state.lastCompletedCheckpoint = params.checkpoint;
    state.deferredWindows = params.remainingDeferredWindows ?? [];
    const run = this.runs.find((r) => r.id === params.runId);
    if (run) {
      run.status = 'COMPLETED';
      run.processedCount = params.processedCount;
      run.summary = params.summary;
    }
    return true;
  }

  async failRun(params: any): Promise<void> {
    const state = this.states.get(params.jobKey);
    if (state && state.fencingToken === params.fencingToken) {
      if (state.leaseOwner === params.instanceId) {
        state.leaseOwner = null;
        state.leaseExpiresAtMs = null;
      }
      state.consecutiveFailures += 1;
      state.lastFailureReason = params.errorDiagnostics;
    }
    const run = this.runs.find((r) => r.id === params.runId);
    if (run) {
      run.status = 'FAILED';
      run.errorDiagnostics = params.errorDiagnostics;
    }
  }

  async releaseOwnedLeasesForInstance(instanceId: string): Promise<number> {
    let released = 0;
    for (const s of this.states.values()) {
      if (s.leaseOwner === instanceId) {
        s.leaseOwner = null;
        s.leaseExpiresAtMs = null;
        released++;
      }
    }
    return released;
  }

  async getMonitoringSnapshot(params: any) {
    return {
      masterEnabled: params.masterEnabled,
      automaticFinancialCorrectionsEnabled: params.automaticFinancialCorrectionsEnabled,
      observerInstanceId: params.instanceId,
      backlog: {
        pendingCpcClaims: 0,
        oldestPendingClaimAgeSeconds: null,
        unassessedPaidClicks: 0,
      },
      jobs: Array.from(this.states.values()),
      recentRuns: this.runs,
      recentErrors: this.runs.filter((r) => r.status === 'FAILED'),
    };
  }
}

describe('PLAN-0114 In-Process Distributed Cron Scheduler & Financial Audits', () => {
  // ─── 1. NEGATIVE / FAILURE CASES FIRST ──────────────────────────────────────

  test('rejects invalid job definitions and mismatched handler jobKeys', () => {
    const registry = new CronJobRegistry();

    expect(() =>
      registry.register({
        jobKey: 'bad key with spaces',
        description: 'Invalid key',
        schedule: '0 */5 * * * *',
        timezone: 'UTC',
        leaseTtlMs: 10_000,
        deadlineMs: 5_000,
        priority: 10,
        isHeavy: false,
        defaultMode: 'REPORT_ONLY',
        featureFlagEnv: 'ADS_TEST_FLAG',
        defaultEnabled: true,
      }),
    ).toThrow('Invalid cron job key');

    expect(() =>
      registry.register({
        jobKey: 'ads.custom.valid',
        description: 'Deadline exceeds lease TTL',
        schedule: '0 */5 * * * *',
        timezone: 'UTC',
        leaseTtlMs: 5_000,
        deadlineMs: 10_000,
        priority: 10,
        isHeavy: false,
        defaultMode: 'REPORT_ONLY',
        featureFlagEnv: 'ADS_TEST_FLAG',
        defaultEnabled: true,
      }),
    ).toThrow('deadlineMs must be between 500ms and leaseTtlMs');
  });

  test('respects master flag ADS_IN_PROCESS_CRON_ENABLED=false and per-job flags without executing handler', async () => {
    const registry = new CronJobRegistry();
    const repo = new FakeCronJobStateRepository();
    const coordinator = new CronExecutionCoordinator(registry, repo as any, 'replica-1');

    let executed = 0;
    const masterDisabled = await coordinator.run(
      'ads.cpc.processing',
      async () => {
        executed++;
        return { processedCount: 1 };
      },
      { env: { ADS_IN_PROCESS_CRON_ENABLED: 'false' } },
    );
    expect(masterDisabled).toEqual({
      status: 'SKIPPED_DISABLED',
      jobKey: 'ads.cpc.processing',
    });
    expect(executed).toBe(0);
    expect(repo.runs).toHaveLength(0);

    const jobDisabled = await coordinator.run(
      'ads.audit.rolling72h',
      async () => {
        executed++;
        return { processedCount: 1 };
      },
      { env: { ADS_IN_PROCESS_CRON_ENABLED: 'true', ADS_AUDIT_ROLLING_72H_ENABLED: 'false' } },
    );
    expect(jobDisabled).toEqual({
      status: 'SKIPPED_DISABLED',
      jobKey: 'ads.audit.rolling72h',
    });
    expect(executed).toBe(0);
  });

  test('never infers automatic financial corrections from monitoring or settlement flags', () => {
    const registry = new CronJobRegistry();
    const envWithAllCronsEnabled: NodeJS.ProcessEnv = {
      ADS_IN_PROCESS_CRON_ENABLED: 'true',
      ADS_CPC_PROCESSOR_ENABLED: 'true',
      ADS_REWARDS_RECONCILE_CRON_ENABLED: 'true',
      ADS_AUDIT_ROLLING_72H_ENABLED: 'true',
      ADS_AUDIT_DAY_15_ENABLED: 'true',
      ADS_AUDIT_DAY_30_ENABLED: 'true',
    };

    expect(registry.isAutomaticFinancialCorrectionsEnabled(envWithAllCronsEnabled)).toBe(false);
    expect(registry.resolveMode('ads.rewards.reconcile', envWithAllCronsEnabled)).toBe('REPORT_ONLY');
    expect(registry.resolveMode('ads.audit.rolling72h', envWithAllCronsEnabled)).toBe('REPORT_ONLY');
    expect(registry.resolveMode('ads.audit.day15', envWithAllCronsEnabled)).toBe('REPORT_ONLY');
    expect(registry.resolveMode('ads.audit.day30', envWithAllCronsEnabled)).toBe('REPORT_ONLY');

    const envWithExplicitApproval: NodeJS.ProcessEnv = {
      ...envWithAllCronsEnabled,
      ADS_AUTOMATIC_FINANCIAL_CORRECTIONS_ENABLED: 'true',
    };
    expect(registry.isAutomaticFinancialCorrectionsEnabled(envWithExplicitApproval)).toBe(true);
    expect(registry.resolveMode('ads.rewards.reconcile', envWithExplicitApproval)).toBe('ACTIVE');
    // Audit jobs remain REPORT_ONLY even when rewards corrections are enabled
    expect(registry.resolveMode('ads.audit.rolling72h', envWithExplicitApproval)).toBe('REPORT_ONLY');
    expect(registry.resolveMode('ads.audit.day15', envWithExplicitApproval)).toBe('REPORT_ONLY');
    expect(registry.resolveMode('ads.audit.day30', envWithExplicitApproval)).toBe('REPORT_ONLY');
  });

  test('retrospective audit handlers reject non-REPORT_ONLY execution mode', async () => {
    const fakeDb = {} as any;
    const rolling = new RollingFraudAuditJob(fakeDb);
    const day15 = new Day15AuditJob(fakeDb);
    const day30 = new Day30AuditJob(fakeDb);

    const badContext = {
      mode: 'ACTIVE',
      assertLeaseOwnership: async () => {},
    } as unknown as CronExecutionContext;

    await expect(rolling.execute(badContext)).rejects.toThrow('REPORT_ONLY');
    await expect(day15.execute(badContext)).rejects.toThrow('REPORT_ONLY');
    await expect(day30.execute(badContext)).rejects.toThrow('REPORT_ONLY');
  });

  test('prevents in-process overlapping execution on the same replica', async () => {
    const registry = new CronJobRegistry();
    const repo = new FakeCronJobStateRepository();
    const coordinator = new CronExecutionCoordinator(registry, repo as any, 'replica-1');

    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstRun = coordinator.run('ads.cpc.processing', async () => {
      await gate;
      return { processedCount: 5 };
    });

    // Trigger overlapping execution on the same instance before first finishes
    const overlapRun = await coordinator.run('ads.cpc.processing', async () => {
      return { processedCount: 99 };
    });

    expect(overlapRun).toEqual({
      status: 'SKIPPED_LOCAL_OVERLAP',
      jobKey: 'ads.cpc.processing',
    });

    releaseFirst();
    const firstOutcome = await firstRun;
    expect(firstOutcome.status).toBe('COMPLETED');
  });

  test('three simulated replicas trigger the same job concurrently, but only one owns execution', async () => {
    const registry = new CronJobRegistry();
    const sharedRepo = new FakeCronJobStateRepository();

    const replica1 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-1');
    const replica2 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-2');
    const replica3 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-3');

    let handlerExecutions = 0;
    const handler = async (ctx: CronExecutionContext) => {
      handlerExecutions++;
      await new Promise((r) => setTimeout(r, 20));
      await ctx.assertLeaseOwnership();
      return { processedCount: 10 };
    };

    const outcomes = await Promise.all([
      replica1.run('ads.cpc.processing', handler),
      replica2.run('ads.cpc.processing', handler),
      replica3.run('ads.cpc.processing', handler),
    ]);

    const completed = outcomes.filter((o) => o.status === 'COMPLETED');
    const skippedLocked = outcomes.filter((o) => o.status === 'SKIPPED_LOCKED');

    expect(completed).toHaveLength(1);
    expect(skippedLocked).toHaveLength(2);
    expect(handlerExecutions).toBe(1);
  });

  test('loss of lease ownership / fencing token prevents continued unauthorized work and checkpoint writes', async () => {
    let fakeClock = 1_700_000_000_000;
    const registry = new CronJobRegistry();
    const sharedRepo = new FakeCronJobStateRepository(() => fakeClock);

    const replica1 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-1');
    const replica2 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-2');

    let unauthorizedWriteCount = 0;

    const replica1Outcome = await replica1.run('ads.cpc.processing', async (ctx) => {
      expect(ctx.fencingToken).toBe(1);
      // Simulate replica-1 stalling past its lease TTL (240_000ms) and replica-2 recovering the lease
      fakeClock += 300_000;
      const recoveryOutcome = await replica2.run('ads.cpc.processing', async (ctx2) => {
        expect(ctx2.fencingToken).toBe(2);
        await ctx2.saveCheckpoint({ recoveredBy: 'replica-2', token: 2 });
        return { processedCount: 4 };
      });
      expect(recoveryOutcome.status).toBe('COMPLETED');

      // Now replica-1 wakes up and tries to checkpoint or continue work — must throw CronLeaseLostError!
      await ctx.saveCheckpoint({ overwrittenBy: 'zombie-replica-1' });
      unauthorizedWriteCount++;
      return { processedCount: 1 };
    });

    expect(replica1Outcome.status).toBe('FAILED');
    expect((replica1Outcome as any).error).toContain('Cron lease ownership lost or expired');
    expect(unauthorizedWriteCount).toBe(0);
    // Durable checkpoint remains replica-2's checkpoint (fencingToken 2)
    expect(sharedRepo.states.get('ads.cpc.processing')?.lastCompletedCheckpoint).toEqual({
      recoveredBy: 'replica-2',
      token: 2,
    });
  });

  test('defers lower-priority heavy retrospective audit when CPC processing occupies heavy capacity, and preserves deferred window', async () => {
    const registry = new CronJobRegistry();
    const sharedRepo = new FakeCronJobStateRepository();
    const replica1 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-1');
    const replica2 = new CronExecutionCoordinator(registry, sharedRepo as any, 'replica-2');

    let finishCpc!: () => void;
    const cpcGate = new Promise<void>((resolve) => {
      finishCpc = resolve;
    });

    const cpcPromise = replica1.run('ads.cpc.processing', async () => {
      await cpcGate;
      return { processedCount: 3 };
    });

    const auditOutcome = await replica2.run(
      'ads.audit.rolling72h',
      async () => ({ processedCount: 50 }),
      {
        deferralWindow: {
          lower: '2026-11-14T00:00:00.000Z',
          upper: '2026-11-14T06:00:00.000Z',
        },
      },
    );

    expect(auditOutcome).toEqual({
      status: 'DEFERRED_CAPACITY',
      jobKey: 'ads.audit.rolling72h',
      runId: expect.any(String),
      activeHeavyJobKeys: ['ads.cpc.processing'],
    });

    finishCpc();
    await cpcPromise;

    // Next audit invocation recovers the deferred window from durable state
    let recoveredWindowsCount = 0;
    const recoveredAudit = await replica2.run('ads.audit.rolling72h', async (ctx) => {
      recoveredWindowsCount = ctx.deferredWindows.length;
      expect(ctx.deferredWindows[0]).toMatchObject({
        lower: '2026-11-14T00:00:00.000Z',
        upper: '2026-11-14T06:00:00.000Z',
      });
      return { processedCount: 25 };
    });

    expect(recoveredAudit.status).toBe('COMPLETED');
    expect(recoveredWindowsCount).toBe(1);
    expect(sharedRepo.states.get('ads.audit.rolling72h')?.deferredWindows).toHaveLength(0);
  });

  // ─── 2. POSITIVE / ARCHITECTURAL / EXTENSIBILITY CASES ──────────────────────

  test('only one ScheduleModule.forRoot() initialization exists in ads-api', () => {
    const adsApiSrc = path.resolve(__dirname, '../../../api/ads-api/src');
    const matches: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('ScheduleModule.forRoot(')) {
            matches.push(path.relative(adsApiSrc, full).replace(/\\/g, '/'));
          }
        }
      }
    }

    walk(adsApiSrc);
    expect(matches).toEqual(['app.module.ts']);
  });

  test('supports registering and running future custom cron jobs without modifying locking infrastructure', async () => {
    const registry = new CronJobRegistry();
    const repo = new FakeCronJobStateRepository();
    const coordinator = new CronExecutionCoordinator(registry, repo as any, 'replica-1');

    const dummyJob = { jobKey: 'dummy', execute: async () => ({ processedCount: 0 }) } as any;
    const scheduler = new AdsCronSchedulerService(
      coordinator,
      registry,
      repo as any,
      { ...dummyJob, jobKey: 'ads.cpc.processing' },
      { ...dummyJob, jobKey: 'ads.traffic.quality' },
      { ...dummyJob, jobKey: 'ads.audit.rolling72h' },
      { ...dummyJob, jobKey: 'ads.audit.day15' },
      { ...dummyJob, jobKey: 'ads.audit.day30' },
      { ...dummyJob, jobKey: 'ads.rewards.reconcile' },
    );

    scheduler.registerCustomJob(
      {
        jobKey: 'ads.cleanup.expired_tokens',
        description: 'Clean up expired impression tokens',
        schedule: '0 30 3 * * *',
        timezone: 'UTC',
        leaseTtlMs: 60_000,
        deadlineMs: 30_000,
        priority: 20,
        isHeavy: false,
        defaultMode: 'ACTIVE',
        featureFlagEnv: 'ADS_CLEANUP_TOKENS_ENABLED',
        defaultEnabled: true,
      },
      {
        jobKey: 'ads.cleanup.expired_tokens',
        execute: async (ctx) => {
          await ctx.saveCheckpoint({ cleanedBatch: 1 });
          return { processedCount: 42, summary: { deleted: 42 } };
        },
      },
    );

    const outcome = await scheduler.runRegisteredJob('ads.cleanup.expired_tokens');
    expect(outcome).toMatchObject({
      status: 'COMPLETED',
      jobKey: 'ads.cleanup.expired_tokens',
      fencingToken: 1,
      result: {
        processedCount: 42,
        summary: { deleted: 42 },
      },
    });

    const controller = new SchedulingMonitorController(scheduler);
    const health = await controller.getSchedulingHealth();
    expect(health.status).toBe('success');
    expect(health.data.jobs.map((j: any) => j.jobKey)).toContain('ads.cleanup.expired_tokens');
  });
});

