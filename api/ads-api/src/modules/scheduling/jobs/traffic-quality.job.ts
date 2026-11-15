import { Inject, Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../../database/database.module';
import { recordPublisherTrafficQualityObservations } from '../../../publisher-traffic-quality-observer';
import type { CronExecutionContext, CronJobHandler, CronJobResult } from '../cron-job-registry';

@Injectable()
export class TrafficQualityJob implements CronJobHandler {
  readonly jobKey = 'ads.traffic.quality';

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async execute(context: CronExecutionContext): Promise<CronJobResult> {
    await context.assertLeaseOwnership();
    const endAt = context.triggerTime ?? new Date();
    const client = (this.db as any).$client ?? this.db;
    const observation = await recordPublisherTrafficQualityObservations(client, { endAt });

    const checkpoint = {
      lastObservedUntil: endAt.toISOString(),
      assessedCohorts: observation.assessedCohorts,
      flaggedReportOnly: observation.flaggedReportOnly,
      mode: context.mode,
    };
    await context.saveCheckpoint(checkpoint);

    return {
      processedCount: observation.assessedCohorts,
      checkpoint,
      summary: {
        mode: context.mode,
        assessedCohorts: observation.assessedCohorts,
        flaggedReportOnly: observation.flaggedReportOnly,
      },
    };
  }
}

