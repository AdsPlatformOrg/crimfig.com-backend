import { Inject, Injectable, Optional } from '@nestjs/common';
import { AdvertiserMilestonesService } from '../../advertiser-milestones/advertiser-milestones.service';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../../database/database.module';
import {
  applyEventCashRebates,
  restoreOverturnedEventCash,
} from '../../../event-cash-rebate-reconciliation';
import {
  houseCfigCorrectionPreview,
  reconcileHouseCfigCorrections,
} from '../../../house-cfig-correction-preview';
import {
  reconcilePaidPointsCorrections,
  recordPaidPointsCorrectionObservations,
} from '../../../paid-points-correction-preview';
import type { CronExecutionContext, CronJobHandler, CronJobResult } from '../cron-job-registry';

@Injectable()
export class RewardsReconciliationJob implements CronJobHandler {
  readonly jobKey = 'ads.rewards.reconcile';

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    @Optional() private readonly milestones?: AdvertiserMilestonesService,
  ) {}

  async execute(
    context: CronExecutionContext,
    windowOverride?: { lower: string; upper: string },
  ): Promise<CronJobResult> {
    await context.assertLeaseOwnership();

    const priorLower =
      typeof context.lastCheckpoint?.lastReconciledUntil === 'string'
        ? context.lastCheckpoint.lastReconciledUntil
        : process.env.ADS_CPC_PROCESSOR_START ||
          new Date(context.triggerTime.getTime() - 72 * 3_600_000).toISOString();
    const upper = windowOverride?.upper ?? context.triggerTime.toISOString();
    const lower = windowOverride?.lower ?? priorLower;
    const window = { lower, upper };

    // Always record non-destructive observations and previews
    const pointsObservations = await recordPaidPointsCorrectionObservations(this.db, window);
    const housePreview = await houseCfigCorrectionPreview(this.db, window);

    await context.assertLeaseOwnership();

    // Automatic retrospective financial deductions, rebates, and reward reversals
    // ONLY execute when explicitly authorized via ADS_AUTOMATIC_FINANCIAL_CORRECTIONS_ENABLED=true
    let cashRebates: unknown = { skippedReportOnly: true };
    let cashRestores: unknown = { skippedReportOnly: true };
    let pointsReconciliation: unknown = { skippedReportOnly: true };
    let houseReconciliation: unknown = { skippedReportOnly: true };

    if (context.allowAutomaticFinancialCorrections && context.mode === 'ACTIVE') {
      cashRebates = await applyEventCashRebates(this.db, window);
      await context.assertLeaseOwnership();
      cashRestores = await restoreOverturnedEventCash(this.db, window);
      await context.assertLeaseOwnership();
      pointsReconciliation = await reconcilePaidPointsCorrections(this.db, window);
      await context.assertLeaseOwnership();
      houseReconciliation = await reconcileHouseCfigCorrections(this.db, window);
    }

    const unsupportedHouseCount = housePreview.filter(
      (award) =>
        award.pendingMicroCfig !== '0' ||
        award.availableMicroCfig !== '0' ||
        award.convertedMicroCfig !== '0',
    ).length;
    const unsupportedPointsCount = pointsObservations.filter(
      (cohort) => cohort.unsupportedPoints !== '0',
    ).length;

    const milestoneCursor = typeof context.lastCheckpoint?.milestoneCursor === 'string' ? context.lastCheckpoint.milestoneCursor : null;
    const milestones = this.milestones ? await this.milestones.reconcile(milestoneCursor, context.mode === 'ACTIVE', () => context.assertLeaseOwnership()) : null;
    const checkpoint = {
      lastReconciledFrom: lower,
      lastReconciledUntil: upper,
      mode: context.mode,
      allowAutomaticFinancialCorrections: context.allowAutomaticFinancialCorrections,
      milestoneCursor: milestones?.cursor ?? null,
    };
    await context.saveCheckpoint(checkpoint);

    return {
      processedCount: pointsObservations.length + housePreview.length + (milestones?.processed ?? 0),
      checkpoint,
      summary: {
        mode: context.mode,
        allowAutomaticFinancialCorrections: context.allowAutomaticFinancialCorrections,
        window,
        pointsCohortsObserved: pointsObservations.length,
        pointsCohortsWithUnsupportedAwards: unsupportedPointsCount,
        houseAwardsEvaluated: housePreview.length,
        houseAwardsWithUnsupportedBalance: unsupportedHouseCount,
        cashRebates,
        cashRestores,
        pointsReconciliation,
        houseReconciliation,
        advertiserRecognition: milestones,
      },
    };
  }
}

