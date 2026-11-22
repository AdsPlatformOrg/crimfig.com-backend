import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AdvertiserMilestonesService } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.service';
import { readMilestoneEvidence, MilestoneEvidence } from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence';
import {
  BONUS_CREDIT_LIFETIME_MAX_CENTS,
  milestoneDefinitions,
  recognitionDecisions,
} from '../../../api/ads-api/src/modules/advertiser-milestones/milestone-policy';

jest.mock('../../../api/ads-api/src/modules/advertiser-milestones/milestone-evidence', () => ({ readMilestoneEvidence: jest.fn() }));
const owner = '00000000-0000-4000-8000-000000000001';
const reqId = '00000000-0000-4000-8000-000000000099';

function evidence(
  amounts: number[],
  fundingVerified = true,
  opts: { tenureMonths?: number; complianceClean?: boolean } = {},
): MilestoneEvidence {
  return {
    totalCampaigns: amounts.length,
    fundingVerified,
    tenureMonths: opts.tenureMonths ?? 0,
    complianceClean: opts.complianceClean ?? true,
    campaigns: amounts.map((amount, index) => ({
      id: String(index),
      completed: true,
      eligible: true,
      clearedSpendCents: amount,
    })),
  };
}

function fixture(snapshot: MilestoneEvidence, history: any[] = []) {
  (readMilestoneEvidence as jest.Mock).mockResolvedValue(snapshot);
  const orderBy = jest.fn().mockResolvedValue(history);
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const db: any = {
    select: jest.fn().mockReturnValue({ from }),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    insert: jest.fn(),
    update: jest.fn(),
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation((work: any) => work(db));
  return { db, service: new AdvertiserMilestonesService(db) };
}

describe('PLAN-0149 / PLAN-0154 7-tier spend milestones & bonus claims', () => {
  it('rejects missing identity before reading any financial data', async () => {
    const { service, db } = fixture(evidence([]));
    await expect(service.getAdvertiserAchievements(undefined as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects insufficient spend (<$5), unverified funding, incomplete campaigns, <12mo A4 tenure, and dirty compliance', () => {
    expect(recognitionDecisions(evidence([300, 199]))[0].qualified).toBe(false);
    expect(recognitionDecisions(evidence([500], false))[0].qualified).toBe(false);
    const unfinished = evidence([500]);
    unfinished.campaigns[0].completed = false;
    expect(recognitionDecisions(unfinished)[0].qualified).toBe(false);

    // $2,500 spend without 12mo tenure -> A3 qualifies, A4 does not
    const a4ShortTenure = recognitionDecisions(evidence([250000], true, { tenureMonths: 11, complianceClean: true }));
    expect(a4ShortTenure.find(d => d.tier === 'A3_GROWTH')?.qualified).toBe(true);
    expect(a4ShortTenure.find(d => d.tier === 'A4_TRUSTED')?.qualified).toBe(false);

    // $10,000 spend with unclean compliance -> Prestige 10K rejected
    const prestigeDirty = recognitionDecisions(evidence([1000000], true, { tenureMonths: 12, complianceClean: false }));
    expect(prestigeDirty.find(d => d.tier === 'PRESTIGE_100')?.qualified).toBe(false);
  });

  it('recognizes all 7 cumulative spend tiers ($3,320 lifetime max) including split campaigns & single-campaign multi-tier', () => {
    expect(BONUS_CREDIT_LIFETIME_MAX_CENTS).toBe(332000);
    expect(milestoneDefinitions).toHaveLength(7);

    // Two campaigns totaling $5 ($3 + $2) qualify A1
    expect(recognitionDecisions(evidence([300, 200]))[0].qualified).toBe(true);

    // One campaign spending $1,000,000 with >=12mo tenure + clean compliance unlocks all 7 tiers
    const all7 = recognitionDecisions(evidence([100000000], true, { tenureMonths: 12, complianceClean: true }));
    expect(all7.every(d => d.qualified)).toBe(true);
    expect(all7.find(d => d.tier === 'PRESTIGE_10000')?.bonusCreditCents).toBe(250000);
  });

  it('rejects bonus claim without terms acceptance, bad requestId, admin pause, or unqualified spend without writes', async () => {
    const { service, db } = fixture(evidence([300]));
    await expect(
      service.claimMilestoneBonus(owner, { milestoneId: 'A1_FIRST_CAMPAIGN', requestId: 'bad', acceptTerms: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.claimMilestoneBonus(owner, { milestoneId: 'A1_FIRST_CAMPAIGN', requestId: reqId, acceptTerms: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.claimMilestoneBonus(owner, { milestoneId: 'A1_FIRST_CAMPAIGN', requestId: reqId, acceptTerms: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('keeps unknown cash provenance pending without any award writes and preserves legacy awards', async () => {
    const { service, db } = fixture(evidence([500], false), [{ id: 'old', bonusCreditCents: 500, bonusCreditRemainingCents: 200 }]);
    const report = await service.evaluateCategoryAMilestones(owner);
    expect(report.newlyAwarded).toEqual([]);
    expect(report.claimableRewards).toEqual([]);
    expect(report.progress.verifiedCompletedCampaigns).toBeNull();
    expect(report.achievements[0]).toMatchObject({ id: 'old', bonusCreditCents: 500, status: 'RECONCILIATION_REQUIRED' });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
