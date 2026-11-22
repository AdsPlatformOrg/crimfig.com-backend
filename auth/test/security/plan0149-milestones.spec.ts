import { UnauthorizedException } from '@nestjs/common';
import { AdvertiserMilestonesService } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.service';
import { readMilestoneEvidence, MilestoneEvidence } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence';
import { recognitionDecisions } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-policy';

jest.mock('../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence', () => ({ readMilestoneEvidence: jest.fn() }));
const owner = '00000000-0000-4000-8000-000000000001';
function evidence(amounts: number[], fundingVerified = true): MilestoneEvidence {
  return { totalCampaigns: amounts.length, fundingVerified,
    campaigns: amounts.map((amount, index) => ({ id: String(index), completed: true, eligible: true, clearedSpendCents: amount })) };
}
function fixture(snapshot: MilestoneEvidence, history: any[] = []) {
  (readMilestoneEvidence as jest.Mock).mockResolvedValue(snapshot);
  const orderBy = jest.fn().mockResolvedValue(history);
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db: any = { select: jest.fn().mockReturnValue({ from }), execute: jest.fn().mockResolvedValue({ rows: [] }),
    insert: jest.fn(), update: jest.fn(), transaction: jest.fn() };
  db.transaction.mockImplementation((work: any) => work(db));
  return { db, service: new AdvertiserMilestonesService(db) };
}
describe('PLAN-0149 recognition safety', () => {
  it('rejects missing identity before reading any financial data', async () => {
    const { service, db } = fixture(evidence([]));
    await expect(service.getAdvertiserAchievements(undefined as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('does not qualify split spend, unknown funding or incomplete campaigns', () => {
    expect(recognitionDecisions(evidence([300, 200]))[0].qualified).toBe(false);
    expect(recognitionDecisions(evidence([500], false))[0].qualified).toBe(false);
    const unfinished = evidence([500]); unfinished.campaigns[0].completed = false;
    expect(recognitionDecisions(unfinished)[0].qualified).toBe(false);
  });
  it('does not count duplicate campaigns toward A2', () => {
    const repeated = evidence([500]);
    repeated.campaigns = Array.from({ length: 3 }, () => repeated.campaigns[0]);
    expect(recognitionDecisions(repeated)[1].qualified).toBe(false);
  });
  it('recognizes an individually eligible $5 campaign and three distinct campaigns', () => {
    expect(recognitionDecisions(evidence([500]))[0].qualified).toBe(true);
    expect(recognitionDecisions(evidence([100, 200, 300]))[1].qualified).toBe(true);
  });
  it('keeps unknown cash provenance pending without any award writes', async () => {
    const { service, db } = fixture(evidence([500], false));
    const report = await service.evaluateCategoryAMilestones(owner);
    expect(report.newlyAwarded).toEqual([]);
    expect(report.claimableRewards).toEqual([]);
    expect(report.progress.verifiedCompletedCampaigns).toBeNull();
    expect(report.totalBonusCreditRemainingCents).toBeNull();
    expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled();
  });
  it('preserves historical amounts and genuine no-activity zeros', async () => {
    const { service } = fixture(evidence([], false), [{ id: 'old', bonusCreditCents: 500, bonusCreditRemainingCents: 200 }]);
    const report = await service.getAdvertiserAchievements(owner);
    expect(report.achievements[0]).toMatchObject({ id: 'old', bonusCreditCents: 500, bonusCreditRemainingCents: 200, status: 'RECONCILIATION_REQUIRED' });
    expect(report.definitions.every(rule => rule.state === 'LOCKED')).toBe(true);
    expect(report.progress.eligibleClearedSpendCents).toBe(0);
    expect(report.progress.verifiedCompletedCampaigns).toBe(0);
  });
});
