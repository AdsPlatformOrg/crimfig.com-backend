import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ADS_ROLES_KEY } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { AdminRewardsControlsController } from '../../../api/ads-api/src/modules/advertiser-milestones/admin-rewards-controls.controller';
import { ProgramControlsService } from '../../../api/ads-api/src/modules/advertiser-milestones/program-controls.service';
import { AdvertiserMilestonesService } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.service';
import { recognitionDecisions } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-policy';
import { readMilestoneEvidence } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence';
import { CronJobRegistry } from '../../../api/ads-api/src/modules/scheduling/cron-job-registry';
import { RewardsReconciliationJob } from '../../../api/ads-api/src/modules/scheduling/jobs/rewards-reconciliation.job';

jest.mock('../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence', () => {
  const actual = jest.requireActual('../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence');
  return { ...actual, readMilestoneEvidence: jest.fn() };
});
jest.mock('../../../api/ads-api/src/event-cash-rebate-reconciliation', () => ({
  applyEventCashRebates: jest.fn(),
  restoreOverturnedEventCash: jest.fn(),
}));
jest.mock('../../../api/ads-api/src/house-cfig-correction-preview', () => ({
  houseCfigCorrectionPreview: jest.fn().mockResolvedValue([]),
  reconcileHouseCfigCorrections: jest.fn(),
}));
jest.mock('../../../api/ads-api/src/paid-points-correction-preview', () => ({
  recordPaidPointsCorrectionObservations: jest.fn().mockResolvedValue([]),
  reconcilePaidPointsCorrections: jest.fn(),
}));

const actor = '00000000-0000-4000-8000-000000000001';
const batchId = '00000000-0000-4000-8000-000000000501';
const req1 = '00000000-0000-4000-8000-000000000101';
const req2 = '00000000-0000-4000-8000-000000000102';
const dialect = new PgDialect();

function makeDb(responder: (sqlText: string, params: any[]) => any[]) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const execute = jest.fn(async (q: any) => {
    const { sql, params } = dialect.sqlToQuery(q);
    if (/^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) writes.push({ sql, params });
    return { rows: responder(sql, params) };
  });
  const db: any = {
    execute,
    select: jest.fn().mockReturnValue({
      from: () => ({ where: () => ({ orderBy: async () => [] }) }),
    }),
    transaction: jest.fn(async (fn: any) => fn({ execute, select: db.select })),
  };
  return { db, controls: new ProgramControlsService(db), writes };
}

describe('PLAN-0155 Live Rewards Accounting, Authority & Compliance — failure cases first', () => {
  beforeEach(() => jest.clearAllMocks());

  it('enforces single super_admin @AdsRoles on reserve transfers, operating proceeds, and manual commitments', () => {
    expect(Reflect.getMetadata(ADS_ROLES_KEY, AdminRewardsControlsController.prototype.transferReserves)).toEqual([
      'super_admin',
    ]);
    expect(
      Reflect.getMetadata(ADS_ROLES_KEY, AdminRewardsControlsController.prototype.recordOperatingProceeds),
    ).toEqual(['super_admin']);
    expect(
      Reflect.getMetadata(ADS_ROLES_KEY, AdminRewardsControlsController.prototype.recordManualCommitment),
    ).toEqual(['super_admin']);
  });

  it('fails closed when a program switch row is missing or locked off (G07)', async () => {
    const missing = makeDb(() => []);
    expect(await missing.controls.isSwitchEnabled('bonus_ad_delivery')).toBe(false);
    expect(await missing.controls.isSwitchEnabled('advertiser_bonus_credit')).toBe(false);

    const locked = makeDb(() => [{ enabled: true, is_locked_off: true }]);
    expect(await locked.controls.isSwitchEnabled('cfig_to_points_conversion')).toBe(false);
  });

  it('rejects invented, unverified, over-claimed, or replayed operating proceeds before any reserve write (G01)', async () => {
    // 1. Free-text non-batch sourceRef rejected with zero writes
    const badRef = makeDb(() => []);
    await expect(
      badRef.controls.recordOperatingProceeds(actor, {
        amountCents: 1000,
        sourceRef: 'invented-free-text-ref',
        reason: 'Fake proceeds',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(badRef.writes).toEqual([]);

    // 2. Non-existent or incomplete batch rejected
    const missingBatch = makeDb(() => []);
    await expect(
      missingBatch.controls.recordOperatingProceeds(actor, {
        amountCents: 1000,
        sourceRef: batchId,
        reason: 'Missing batch',
        requestId: req1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(missingBatch.writes).toEqual([]);

    // 3. Batch already deposited with a different requestId cannot be credited a second time
    let alreadyConsumed = false;
    const duplicateBatch = makeDb((sqlText) => {
      if (sqlText.includes('FROM ads_settlement_batches b')) {
        return [{ id: batchId, status: 'completed', total_debited_usd_cents: 5000, total_credited_usd_cents: 2750, rebate_cents: 0 }];
      }
      if (sqlText.includes("from_reserve = 'realized_platform_proceeds'")) {
        return alreadyConsumed ? [{ id: actor, amount_cents: 2250 }] : [];
      }
      if (sqlText.includes('SELECT id FROM platform_operating_reserve')) {
        return [{ id: actor }];
      }
      if (sqlText.includes('INSERT INTO platform_reserve_transfers')) {
        alreadyConsumed = true;
        return [{ id: actor, request_id: req1, source_ref: `settlement-batch:${batchId}`, amount_cents: 2250 }];
      }
      return [];
    });

    await duplicateBatch.controls.recordOperatingProceeds(actor, {
      amountCents: 2250,
      sourceRef: `settlement-batch:${batchId}`,
      reason: 'First verified deposit',
      requestId: req1,
    });
    await expect(
      duplicateBatch.controls.recordOperatingProceeds(actor, {
        amountCents: 100,
        sourceRef: batchId,
        reason: 'Second deposit with fresh requestId',
        requestId: req2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects unknown compliance for A4/Prestige and holds ONLY A4/Prestige during investigation while keeping A1-A3 claimable (G08)', () => {
    // Unknown compliance (undefined) must NOT satisfy clean compliance
    const unknownCompliance = recognitionDecisions({
      totalCampaigns: 1,
      fundingVerified: true,
      tenureMonths: 14,
      complianceClean: undefined,
      campaigns: [{ id: 'c1', completed: false, qualifying: true, eligible: true, clearedSpendCents: 1_000_000 }],
    });
    expect(unknownCompliance.find(d => d.tier === 'A3_GROWTH')?.qualified).toBe(true);
    expect(unknownCompliance.find(d => d.tier === 'A4_TRUSTED')?.qualified).toBe(false);
    expect(unknownCompliance.find(d => d.tier === 'PRESTIGE_100')?.qualified).toBe(false);

    // Pending investigation holds ONLY A4 & Prestige; A1-A3 remain qualified
    const underInvestigation = recognitionDecisions({
      totalCampaigns: 1,
      fundingVerified: true,
      tenureMonths: 14,
      complianceClean: true,
      underInvestigation: true,
      campaigns: [{ id: 'c1', completed: false, qualifying: true, eligible: true, clearedSpendCents: 1_000_000 }],
    });
    expect(underInvestigation.find(d => d.tier === 'A1_FIRST_CAMPAIGN')?.qualified).toBe(true);
    expect(underInvestigation.find(d => d.tier === 'A2_CONSISTENT')?.qualified).toBe(true);
    expect(underInvestigation.find(d => d.tier === 'A3_GROWTH')?.qualified).toBe(true);
    expect(underInvestigation.find(d => d.tier === 'A4_TRUSTED')).toMatchObject({
      qualified: false,
      heldByInvestigation: true,
    });
    expect(underInvestigation.find(d => d.tier === 'PRESTIGE_100')).toMatchObject({
      qualified: false,
      heldByInvestigation: true,
    });
  });

  it('preserves permanent Prestige badge unless confirmedFraud is true, while blocking legacy duplicate monetary claim (G06, G08)', async () => {
    (readMilestoneEvidence as jest.Mock).mockResolvedValue({
      totalCampaigns: 1,
      fundingVerified: true,
      tenureMonths: 12,
      complianceClean: true,
      underInvestigation: true,
      confirmedFraud: false,
      campaigns: [{ id: 'c1', completed: true, qualifying: true, eligible: true, clearedSpendCents: 500 }],
    });
    const { db, controls } = makeDb((sqlText) => {
      if (sqlText.includes('FROM program_feature_switches')) {
        return [{ enabled: true, is_locked_off: false }];
      }
      if (sqlText.includes('FROM advertiser_recognition_awards')) {
        return [{ id: req1, milestone_id: 'PRESTIGE_100', state: 'qualified', first_qualified_at: new Date(), updated_at: new Date() }];
      }
      if (sqlText.includes('FROM advertiser_achievements') && sqlText.includes('bonus_credit_cents > 0')) {
        return [{ id: 'legacy-paid-a1' }];
      }
      return [];
    });
    const milestones = new AdvertiserMilestonesService(db, controls);
    const evaluated = await milestones.evaluateCategoryAMilestones(actor);
    const prestigeBadge = evaluated.badges.find((b: any) => b.tier === 'PRESTIGE_100');
    expect(prestigeBadge?.state).toBe('qualified');

    // Legacy monetary achievement blocks second economic claim on A1
    await expect(
      milestones.claimMilestoneBonus(actor, {
        milestoneId: 'A1_FIRST_CAMPAIGN',
        requestId: req2,
        acceptTerms: true,
      }),
    ).rejects.toThrow(/prior lifetime monetary bonus award/);
  });

  it('runs forward rewards settlement explicitly without enabling retrospective financial clawbacks (G11)', async () => {
    const registry = new CronJobRegistry();
    expect(registry.isForwardRewardsSettlementEnabled({})).toBe(true);
    expect(registry.isAutomaticFinancialCorrectionsEnabled({})).toBe(false);
    expect(registry.resolveMode('ads.rewards.reconcile', {})).toBe('REPORT_ONLY');

    const reconcile = jest.fn().mockResolvedValue({ processed: 3, cursor: null });
    const clearMaturedBonusPromoEarnings = jest.fn().mockResolvedValue({ clearedCount: 37, paidCents: 1 });
    const saveCheckpoint = jest.fn();
    const job = new RewardsReconciliationJob(
      {} as any,
      { reconcile } as any,
      { clearMaturedBonusPromoEarnings } as any,
    );

    const res = await job.execute(
      {
        jobKey: 'ads.rewards.reconcile',
        runId: 'r1',
        instanceId: 'i1',
        fencingToken: 1,
        triggerTime: new Date('2026-11-25T00:00:00Z'),
        startedAt: new Date('2026-11-25T00:00:00Z'),
        deadlineAt: new Date('2026-11-25T00:01:00Z'),
        mode: 'REPORT_ONLY',
        allowAutomaticFinancialCorrections: false,
        signal: new AbortController().signal,
        lastCheckpoint: null,
        deferredWindows: [],
        assertLeaseOwnership: async () => {},
        saveCheckpoint,
      },
      undefined,
      { persistForwardSettlement: true },
    );

    expect(reconcile).toHaveBeenCalledWith(null, true, expect.any(Function));
    expect(clearMaturedBonusPromoEarnings).toHaveBeenCalledTimes(1);
    expect(res.summary?.cashRebates).toEqual({ skippedReportOnly: true });
    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'REPORT_ONLY', persistForwardSettlement: true }),
    );
  });
});
