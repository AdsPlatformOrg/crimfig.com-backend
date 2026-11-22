import { RewardsReconciliationJob } from '../../../api/ads-api/src/modules/scheduling/jobs/rewards-reconciliation.job';
import { applyEventCashRebates } from '../../../api/ads-api/src/event-cash-rebate-reconciliation';

jest.mock('../../../api/ads-api/src/event-cash-rebate-reconciliation', () => ({
  applyEventCashRebates: jest.fn(), restoreOverturnedEventCash: jest.fn(),
}));
jest.mock('../../../api/ads-api/src/house-cfig-correction-preview', () => ({
  houseCfigCorrectionPreview: jest.fn().mockResolvedValue([]), reconcileHouseCfigCorrections: jest.fn(),
}));
jest.mock('../../../api/ads-api/src/paid-points-correction-preview', () => ({
  recordPaidPointsCorrectionObservations: jest.fn().mockResolvedValue([]), reconcilePaidPointsCorrections: jest.fn(),
}));

describe('PLAN0149 scheduled recognition', () => {
  function fixture(mode: 'ACTIVE' | 'REPORT_ONLY') {
    const reconcile = jest.fn().mockResolvedValue({ processed: 100, cursor: 'next-owner' });
    const context: any = { mode, allowAutomaticFinancialCorrections: false,
      triggerTime: new Date('2026-11-22T00:00:00Z'), lastCheckpoint: { milestoneCursor: 'prior-owner' },
      assertLeaseOwnership: jest.fn().mockResolvedValue(undefined), saveCheckpoint: jest.fn() };
    return { reconcile, context, job: new RewardsReconciliationJob({} as any, { reconcile } as any) };
  }
  beforeEach(() => jest.clearAllMocks());
  it('persists recognition in ACTIVE mode without enabling financial corrections', async () => {
    const { job, context, reconcile } = fixture('ACTIVE');
    const result = await job.execute(context);
    expect(reconcile).toHaveBeenCalledWith('prior-owner', true, expect.any(Function));
    await reconcile.mock.calls[0][2]();
    expect(context.assertLeaseOwnership).toHaveBeenCalledTimes(3);
    expect(applyEventCashRebates).not.toHaveBeenCalled();
    expect(result.processedCount).toBe(100);
    expect(context.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ milestoneCursor: 'next-owner' }));
  });
  it('uses a non-writing recognition preview in REPORT_ONLY mode', async () => {
    const { job, context, reconcile } = fixture('REPORT_ONLY');
    await job.execute(context);
    expect(reconcile).toHaveBeenCalledWith('prior-owner', false, expect.any(Function));
    expect(applyEventCashRebates).not.toHaveBeenCalled();
  });
  it('does not evaluate or advance the checkpoint after losing its lease', async () => {
    const { job, context, reconcile } = fixture('ACTIVE');
    context.assertLeaseOwnership.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'));
    await expect(job.execute(context)).rejects.toThrow('lease lost');
    expect(reconcile).not.toHaveBeenCalled();
    expect(context.saveCheckpoint).not.toHaveBeenCalled();
  });
});
