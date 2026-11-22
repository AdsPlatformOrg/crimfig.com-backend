import { Module } from '@nestjs/common';
import { DashboardAuthModule } from '@crimfig/shared';
import { DatabaseModule } from '../database/database.module';
import { CronJobRegistry } from './cron-job-registry';
import { CronJobStateRepository } from './cron-job-state.repository';
import { CronExecutionCoordinator } from './cron-execution-coordinator.service';
import { AdsCronSchedulerService } from './ads-cron-scheduler.service';
import { SchedulingMonitorController } from './scheduling-monitor.controller';
import { CpcProcessingJob } from './jobs/cpc-processing.job';
import { TrafficQualityJob } from './jobs/traffic-quality.job';
import { RollingFraudAuditJob } from './jobs/rolling-fraud-audit.job';
import { Day15AuditJob } from './jobs/day-15-audit.job';
import { Day30AuditJob } from './jobs/day-30-audit.job';
import { RewardsReconciliationJob } from './jobs/rewards-reconciliation.job';
import { AdvertiserMilestonesModule } from '../advertiser-milestones/advertiser-milestones.module';

@Module({
  imports: [DatabaseModule, DashboardAuthModule, AdvertiserMilestonesModule],
  controllers: [SchedulingMonitorController],
  providers: [
    CronJobRegistry,
    CronJobStateRepository,
    CronExecutionCoordinator,
    CpcProcessingJob,
    TrafficQualityJob,
    RollingFraudAuditJob,
    Day15AuditJob,
    Day30AuditJob,
    RewardsReconciliationJob,
    AdsCronSchedulerService,
  ],
  exports: [
    CronJobRegistry,
    CronJobStateRepository,
    CronExecutionCoordinator,
    AdsCronSchedulerService,
  ],
})
export class SchedulingModule {}

