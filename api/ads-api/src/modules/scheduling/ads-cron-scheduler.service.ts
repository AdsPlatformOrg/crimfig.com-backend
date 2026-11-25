import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronExecutionCoordinator, type CoordinatorRunOptions } from './cron-execution-coordinator.service';
import { CronJobRegistry, type CronJobHandler, type CronJobDefinition } from './cron-job-registry';
import { CronJobStateRepository } from './cron-job-state.repository';
import { CpcProcessingJob } from './jobs/cpc-processing.job';
import { TrafficQualityJob } from './jobs/traffic-quality.job';
import { RollingFraudAuditJob } from './jobs/rolling-fraud-audit.job';
import { Day15AuditJob } from './jobs/day-15-audit.job';
import { Day30AuditJob } from './jobs/day-30-audit.job';
import { RewardsReconciliationJob } from './jobs/rewards-reconciliation.job';

@Injectable()
export class AdsCronSchedulerService {
  private readonly customHandlers = new Map<string, CronJobHandler>();

  constructor(
    private readonly coordinator: CronExecutionCoordinator,
    private readonly registry: CronJobRegistry,
    private readonly stateRepo: CronJobStateRepository,
    private readonly clicks: CpcProcessingJob,
    private readonly trafficQuality: TrafficQualityJob,
    private readonly rollingAudit: RollingFraudAuditJob,
    private readonly day15Audit: Day15AuditJob,
    private readonly day30Audit: Day30AuditJob,
    private readonly rewardsReconcile: RewardsReconciliationJob,
  ) {
    this.customHandlers.set(this.clicks.jobKey, this.clicks);
    this.customHandlers.set(this.trafficQuality.jobKey, this.trafficQuality);
    this.customHandlers.set(this.rollingAudit.jobKey, this.rollingAudit);
    this.customHandlers.set(this.day15Audit.jobKey, this.day15Audit);
    this.customHandlers.set(this.day30Audit.jobKey, this.day30Audit);
    this.customHandlers.set(this.rewardsReconcile.jobKey, this.rewardsReconcile);
  }

  /**
   * Extensibility hook: allows registering a new cron job definition and its handler
   * without modifying locking, fencing, or durable state infrastructure.
   */
  registerCustomJob(definition: CronJobDefinition, handler: CronJobHandler): void {
    if (definition.jobKey !== handler.jobKey) {
      throw new Error(
        `CronJobDefinition jobKey "${definition.jobKey}" does not match handler jobKey "${handler.jobKey}"`,
      );
    }
    this.registry.register(definition);
    this.customHandlers.set(definition.jobKey, handler);
  }

  async runRegisteredJob(jobKey: string, options?: CoordinatorRunOptions) {
    const handler = this.customHandlers.get(jobKey);
    if (!handler) {
      throw new Error(`No handler registered for cron job "${jobKey}"`);
    }
    return this.coordinator.run(jobKey, (context) => handler.execute(context), options);
  }

  @Cron('0 */5 * * * *', {
    name: 'ads.cpc.processing',
    timeZone: 'UTC',
  })
  async processClicks(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.cpc.processing',
      (context) => this.clicks.execute(context),
      options,
    );
  }

  @Cron('0 0 */6 * * *', {
    name: 'ads.audit.rolling72h',
    timeZone: 'UTC',
  })
  async auditRecentTraffic(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.audit.rolling72h',
      (context) => this.rollingAudit.execute(context),
      options,
    );
  }

  @Cron('0 15 2 * * *', {
    name: 'ads.audit.day15',
    timeZone: 'UTC',
  })
  async auditDay15(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.audit.day15',
      (context) => this.day15Audit.execute(context),
      options,
    );
  }

  @Cron('0 45 2 * * *', {
    name: 'ads.audit.day30',
    timeZone: 'UTC',
  })
  async auditDay30(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.audit.day30',
      (context) => this.day30Audit.execute(context),
      options,
    );
  }

  async observeTrafficQuality(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.traffic.quality',
      (context) => this.trafficQuality.execute(context),
      options,
    );
  }

  async reconcileRewards(options?: CoordinatorRunOptions) {
    return this.coordinator.run(
      'ads.rewards.reconcile',
      (context) =>
        this.rewardsReconcile.execute(context, undefined, {
          persistForwardSettlement: this.registry.isForwardRewardsSettlementEnabled(
            options?.env ?? process.env,
          ),
        }),
      options,
    );
  }

  async getHealthSnapshot(env: NodeJS.ProcessEnv = process.env) {
    await this.stateRepo.seedRegisteredJobs(
      this.registry.list(),
      (key) => this.registry.isJobEnabled(key, env),
      (key) => this.registry.resolveMode(key, env),
      (key) => this.registry.computeNextExpectedRun(key),
    );
    return this.stateRepo.getMonitoringSnapshot({
      masterEnabled: this.registry.isMasterEnabled(env),
      automaticFinancialCorrectionsEnabled:
        this.registry.isAutomaticFinancialCorrectionsEnabled(env),
      instanceId: this.coordinator.instanceId,
    });
  }
}

