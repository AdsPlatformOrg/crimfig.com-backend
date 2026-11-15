import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import {
  type CronExecutionContext,
  type CronJobResult,
  CronJobRegistry,
  CronLeaseLostError,
} from './cron-job-registry';
import { CronJobStateRepository } from './cron-job-state.repository';

export interface CoordinatorRunOptions {
  triggerTime?: Date;
  env?: NodeJS.ProcessEnv;
  deferralWindow?: { lower: string; upper: string };
}

export type CoordinatorRunOutcome =
  | {
      status: 'COMPLETED';
      jobKey: string;
      runId: string;
      fencingToken: number;
      result: CronJobResult;
    }
  | {
      status: 'SKIPPED_LOCAL_OVERLAP';
      jobKey: string;
    }
  | {
      status: 'SKIPPED_DISABLED';
      jobKey: string;
    }
  | {
      status: 'SKIPPED_LOCKED';
      jobKey: string;
      runId: string;
      currentOwner: string | null;
    }
  | {
      status: 'DEFERRED_CAPACITY';
      jobKey: string;
      runId: string;
      activeHeavyJobKeys: string[];
    }
  | {
      status: 'FAILED';
      jobKey: string;
      runId: string;
      fencingToken: number;
      error: string;
    };

@Injectable()
export class CronExecutionCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronExecutionCoordinator.name);
  private readonly activeLocalControllers = new Map<string, AbortController>();
  public readonly instanceId: string;

  constructor(
    private readonly registry: CronJobRegistry,
    private readonly stateRepo: CronJobStateRepository,
    @Optional() instanceIdOverride?: string,
  ) {
    this.instanceId =
      instanceIdOverride ||
      process.env.RAILWAY_REPLICA_ID ||
      `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.stateRepo.seedRegisteredJobs(
        this.registry.list(),
        (key) => this.registry.isJobEnabled(key),
        (key) => this.registry.resolveMode(key),
        (key) => this.registry.computeNextExpectedRun(key),
      );
    } catch (error: any) {
      this.logger.warn(
        `Deferred cron job state seeding until first database availability: ${error?.message ?? error}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [jobKey, controller] of this.activeLocalControllers.entries()) {
      controller.abort(new Error(`Service instance ${this.instanceId} shutting down (${jobKey})`));
    }
    this.activeLocalControllers.clear();
    try {
      await this.stateRepo.releaseOwnedLeasesForInstance(this.instanceId);
    } catch {
      // Ignore shutdown release errors if pool is already closing
    }
  }

  private resolveMaxConcurrentHeavyJobs(env: NodeJS.ProcessEnv): number {
    const raw = Number.parseInt(String(env.ADS_CRON_MAX_CONCURRENT_HEAVY ?? '1'), 10);
    return Number.isSafeInteger(raw) && raw >= 1 && raw <= 10 ? raw : 1;
  }

  async run(
    jobKey: string,
    handler: (context: CronExecutionContext) => Promise<CronJobResult>,
    options: CoordinatorRunOptions = {},
  ): Promise<CoordinatorRunOutcome> {
    const env = options.env ?? process.env;
    const definition = this.registry.getOrThrow(jobKey);

    if (!this.registry.isJobEnabled(jobKey, env)) {
      return {
        status: 'SKIPPED_DISABLED',
        jobKey,
      };
    }

    if (this.activeLocalControllers.has(jobKey)) {
      this.logger.warn(`Skipping overlapping in-process trigger for cron job "${jobKey}" on ${this.instanceId}`);
      return {
        status: 'SKIPPED_LOCAL_OVERLAP',
        jobKey,
      };
    }

    const triggerTime = options.triggerTime ?? new Date();
    const nextExpectedRunAt = this.registry.computeNextExpectedRun(jobKey, triggerTime);
    const mode = this.registry.resolveMode(jobKey, env);
    const allowAutomaticFinancialCorrections =
      this.registry.isAutomaticFinancialCorrectionsEnabled(env);
    const maxConcurrentHeavyJobs = this.resolveMaxConcurrentHeavyJobs(env);

    const abortController = new AbortController();
    this.activeLocalControllers.set(jobKey, abortController);

    try {
      const lease = await this.stateRepo.tryAcquireLease({
        definition,
        instanceId: this.instanceId,
        mode,
        triggerTime,
        nextExpectedRunAt,
        maxConcurrentHeavyJobs,
        deferralWindow: options.deferralWindow,
      });

      if (lease.outcome === 'SKIPPED_LOCKED') {
        return {
          status: 'SKIPPED_LOCKED',
          jobKey,
          runId: lease.runId,
          currentOwner: lease.currentOwner,
        };
      }

      if (lease.outcome === 'DEFERRED_CAPACITY') {
        this.logger.log(
          `Deferred heavy cron job "${jobKey}" (${lease.runId}) because heavy execution capacity is occupied by [${lease.activeHeavyJobKeys.join(', ')}]`,
        );
        return {
          status: 'DEFERRED_CAPACITY',
          jobKey,
          runId: lease.runId,
          activeHeavyJobKeys: lease.activeHeavyJobKeys,
        };
      }

      const { runId, fencingToken, startedAt } = lease;
      const deadlineAt = new Date(Date.now() + definition.deadlineMs);
      let leaseLost = false;
      let latestCheckpoint = lease.lastCheckpoint;

      const heartbeatIntervalMs = Math.max(500, Math.floor(definition.leaseTtlMs / 3));
      const heartbeatTimer = setInterval(async () => {
        try {
          const renewed = await this.stateRepo.renewLease(
            jobKey,
            this.instanceId,
            fencingToken,
            definition.leaseTtlMs,
          );
          if (!renewed) {
            leaseLost = true;
            abortController.abort(new CronLeaseLostError(jobKey, this.instanceId, fencingToken));
          }
        } catch {
          leaseLost = true;
          abortController.abort(new CronLeaseLostError(jobKey, this.instanceId, fencingToken));
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();

      const deadlineTimer = setTimeout(() => {
        abortController.abort(
          new Error(`Cron execution deadline (${definition.deadlineMs}ms) exceeded for "${jobKey}"`),
        );
      }, definition.deadlineMs);
      deadlineTimer.unref?.();

      const context: CronExecutionContext = {
        jobKey,
        runId,
        instanceId: this.instanceId,
        fencingToken,
        triggerTime,
        startedAt,
        deadlineAt,
        mode,
        allowAutomaticFinancialCorrections,
        signal: abortController.signal,
        get lastCheckpoint() {
          return latestCheckpoint;
        },
        deferredWindows: lease.deferredWindows,
        assertLeaseOwnership: async () => {
          if (leaseLost || abortController.signal.aborted) {
            const reason = abortController.signal.reason;
            if (reason instanceof Error) throw reason;
            throw new CronLeaseLostError(jobKey, this.instanceId, fencingToken);
          }
          if (Date.now() >= deadlineAt.getTime()) {
            throw new Error(`Cron execution deadline (${definition.deadlineMs}ms) exceeded for "${jobKey}"`);
          }
          const stillOwned = await this.stateRepo.verifyLeaseOwnership(
            jobKey,
            this.instanceId,
            fencingToken,
          );
          if (!stillOwned) {
            leaseLost = true;
            const err = new CronLeaseLostError(jobKey, this.instanceId, fencingToken);
            abortController.abort(err);
            throw err;
          }
        },
        saveCheckpoint: async (checkpoint: Record<string, unknown>) => {
          await context.assertLeaseOwnership();
          await this.stateRepo.saveCheckpoint({
            jobKey,
            instanceId: this.instanceId,
            fencingToken,
            runId,
            checkpoint,
          });
          latestCheckpoint = checkpoint;
        },
      };

      try {
        const result = await handler(context);
        await context.assertLeaseOwnership();

        const finalCheckpoint = result.checkpoint ?? latestCheckpoint ?? undefined;
        const committed = await this.stateRepo.completeRun({
          jobKey,
          instanceId: this.instanceId,
          fencingToken,
          runId,
          startedAt,
          nextExpectedRunAt,
          processedCount: result.processedCount ?? 0,
          failedCount: result.failedCount ?? 0,
          deferredCount: result.deferredCount ?? 0,
          checkpoint: finalCheckpoint,
          summary: result.summary,
          remainingDeferredWindows: [],
        });

        if (!committed) {
          throw new CronLeaseLostError(
            jobKey,
            this.instanceId,
            fencingToken,
            `Lease ownership lost before completion commit for "${jobKey}"`,
          );
        }

        return {
          status: 'COMPLETED',
          jobKey,
          runId,
          fencingToken,
          result,
        };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Cron job "${jobKey}" (runId=${runId}, token=${fencingToken}) failed: ${message}`,
        );
        await this.stateRepo.failRun({
          jobKey,
          instanceId: this.instanceId,
          fencingToken,
          runId,
          startedAt,
          nextExpectedRunAt,
          errorDiagnostics: message,
        });
        return {
          status: 'FAILED',
          jobKey,
          runId,
          fencingToken,
          error: message,
        };
      } finally {
        clearInterval(heartbeatTimer);
        clearTimeout(deadlineTimer);
      }
    } finally {
      this.activeLocalControllers.delete(jobKey);
    }
  }
}

