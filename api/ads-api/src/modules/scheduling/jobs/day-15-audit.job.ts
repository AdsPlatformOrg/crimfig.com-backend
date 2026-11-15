import { Inject, Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../../database/database.module';
import { runAuditLevelCohort } from '../../../scheduled-click-audits';
import type { CronExecutionContext, CronJobHandler, CronJobResult } from '../cron-job-registry';

@Injectable()
export class Day15AuditJob implements CronJobHandler {
  readonly jobKey = 'ads.audit.day15';

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async execute(context: CronExecutionContext): Promise<CronJobResult> {
    if (context.mode !== 'REPORT_ONLY') {
      throw new Error('Day 15 extended audit must run in REPORT_ONLY mode until separately authorized');
    }
    await context.assertLeaseOwnership();

    const defaultStart = new Date(context.triggerTime.getTime() - 16 * 24 * 3_600_000).toISOString();
    const start =
      process.env.ADS_CPC_PROCESSOR_START ||
      (typeof context.lastCheckpoint?.bucketIso === 'string'
        ? context.lastCheckpoint.bucketIso
        : defaultStart);

    const auditResult = await runAuditLevelCohort(this.db, 'tier3_15d', start, {
      now: context.triggerTime.getTime(),
      maxBatches: 8,
      assertLeaseOwnership: () => context.assertLeaseOwnership(),
      onCheckpoint: (cp) => context.saveCheckpoint(cp),
    });

    const checkpoint = {
      ...(context.lastCheckpoint ?? {}),
      auditLevel: 'tier3_15d',
      lastCompletedBucketIso:
        auditResult.lastCompletedBucketIso ??
        (context.lastCheckpoint?.lastCompletedBucketIso as string | null) ??
        null,
      completedAllDueBuckets: auditResult.completedAllDueBuckets,
      mode: 'REPORT_ONLY',
    };

    return {
      processedCount: auditResult.interactionsAnalyzed,
      checkpoint,
      summary: {
        mode: 'REPORT_ONLY',
        financialMutationsPerformed: 0,
        ...auditResult,
        recoveredDeferredWindows: context.deferredWindows.length,
      },
    };
  }
}

