import { EVENT_WINDOW_MS, INGEST_TOLERANCE_MS, NANO_CENT } from '@crimfig/shared';
import { randomUUID } from 'crypto';
import {
  computeAdaptiveHourlyPacingDetails,
  computeEffectiveHourlyAllowanceNanos,
  getWatHour,
} from '../../../api/billing-api/src/modules/ecosystem/adaptive-pacing';
import { AdOpportunityService } from '../../../api/billing-api/src/modules/ecosystem/ad-opportunity.service';
import { AuctionEngineService } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { auctionScoreMicros, eventPriceNanos } from '../../../api/ads-api/src/modules/delivery/pricing-contract';

const POLICY = {
  version: '2026-11-14-v1',
  approvedBy: 'JED',
  approvedAt: '2026-11-14T00:00:00.000Z',
  fractionalClosure: 'write_off_subcent',
  pctrBasisPoints: 150,
  pricing: 'second_price',
  bidderGrouping: 'campaign',
  floors: 'bid_and_clearing',
  eventWindowMs: EVENT_WINDOW_MS,
  ingestionToleranceMs: INGEST_TOLERANCE_MS,
};

function makeOpportunityInput(overrides: Partial<Record<string, any>> = {}) {
  const opportunityId = randomUUID();
  const campaignId = randomUUID();
  const creativeId = randomUUID();
  const submissionId = randomUUID();
  const promoterId = randomUUID();
  const websiteId = randomUUID();
  const slotId = randomUUID();
  const clearingPriceMicros = auctionScoreMicros('cpc', 10);
  const priceNanos = eventPriceNanos('cpc', clearingPriceMicros).toString();
  return {
    serveBefore: new Date(Date.now() + 5000).toISOString(),
    opportunityId,
    campaignId,
    creativeId,
    submissionId,
    contentRevision: 1,
    promoterId,
    websiteId,
    slotId,
    policyVersion: POLICY.version,
    priceNanos,
    clearingPriceMicros,
    visitorKey: 'a'.repeat(64),
    ipHash: 'b'.repeat(16),
    decision: {
      requestId: opportunityId,
      winnerCampaignId: campaignId,
      winnerCreativeId: creativeId,
      clearingPriceMicros,
      policyVersion: POLICY.version,
      bidderGroupingMode: 'campaign',
      billingPriceNanos: priceNanos,
      evaluatedCandidates: [],
      excludedCandidates: [],
      tieSeed: 'seed-1',
    },
    ...overrides,
  };
}

function makeReserveDbStub(
  usage: { outstanding: string; daily: string; hourly: string; frequency: number },
  campaignOverrides: Record<string, any> = {},
  escrowOverrides: Record<string, any> = {},
) {
  const inserted: any[] = [];
  const inputRef = {
    campaignId: '',
    creativeId: '',
    submissionId: '',
    promoterId: '',
    websiteId: '',
    slotId: '',
    advertiserId: randomUUID(),
    promoterUserId: randomUUID(),
  };

  let selectCall = 0;
  const tx: any = {
    execute: jest.fn(async (q: any) => {
      const sqlText = JSON.stringify(q);
      if (sqlText.includes('ads_traffic_controls')) return { rows: [] };
      if (sqlText.includes('ads_opportunity_reservations') && sqlText.includes('outstanding')) return { rows: [usage] };
      if (sqlText.includes('ads_settlement_carries')) return { rows: [{ nanos: '0' }] };
      return { rows: [] };
    }),
    select: jest.fn(() => {
      selectCall += 1;
      const call = selectCall;
      const chain: any = {
        from: jest.fn(() => chain),
        innerJoin: jest.fn(() => chain),
        where: jest.fn(() => chain),
        for: jest.fn(() => chain),
        limit: jest.fn(async () => {
          if (call === 1) {
            return [{
              id: inputRef.campaignId,
              advertiserId: inputRef.advertiserId,
              status: 'active',
              moderationStatus: 'approved',
              currentSubmissionId: inputRef.submissionId,
              approvedSubmissionId: inputRef.submissionId,
              contentRevision: 1,
              approvedRevision: 1,
              pricingVersion: 2,
              pricingModel: 'cpc',
              costPerClickUsdCents: 10,
              costPerImpressionUsdCents: null,
              remainingBudgetUsdCents: 4970,
              dailyBudgetUsdCents: 500,
              hourlyPacingUsdCents: 21,
              frequencyCapPerDay: 20,
              startsAt: null,
              endsAt: null,
              ...campaignOverrides,
            }];
          }
          if (call === 2) return [];
          if (call === 3) {
            return [{
              slot: { id: inputRef.slotId, slotType: 'network', isActive: true, lifecycleStatus: 'active', installationStatus: 'verified', format: 'banner', allowedAdTypes: JSON.stringify(['text']), slotTagId: 'slot-1', policyRevision: 1 },
              site: { id: inputRef.websiteId, promoterId: inputRef.promoterId, isActive: true, isSuspended: false, policyStatus: 'approved', verificationStatus: 'verified', verificationExpiresAt: new Date(Date.now() + 86400000) },
              promoter: { id: inputRef.promoterId, userId: inputRef.promoterUserId, isActive: true, isSuspended: false },
            }];
          }
          if (call === 5) return [{ id: inputRef.creativeId, campaignId: inputRef.campaignId, adStackId: 'stack-1', adType: 'text', adFormat: 'banner', status: 'active', reviewStatus: 'approved', mediaAssetId: null }];
          if (call === 6) return [{ id: 'stack-1', campaignId: inputRef.campaignId, archived: false }];
          if (call === 7) return [{ id: 'escrow-1', campaignId: inputRef.campaignId, userId: inputRef.advertiserId, status: 'active', allocatedUsdCents: 5000, consumedUsdCents: 30, refundedUsdCents: 0, ...escrowOverrides }];
          if (call === 8) {
            const allocated = escrowOverrides.allocatedUsdCents ?? 5000;
            return [{
              id: 'tx-1',
              status: 'completed',
              type: 'internal_debit',
              amountUsdCents: allocated,
              provider: 'internal',
              userId: inputRef.advertiserId,
              metadata: JSON.stringify({ version: 2, kind: 'campaign_escrow', action: 'reserve', campaignId: inputRef.campaignId, escrowId: 'escrow-1', allocatedUsdCents: allocated }),
            }];
          }
          return [];
        }),
        then: (resolve: any) => {
          if (call === 4) {
            return resolve([{ id: inputRef.advertiserId, status: 'ACTIVE' }, { id: inputRef.promoterUserId, status: 'ACTIVE' }]);
          }
          return resolve([]);
        },
      };
      return chain;
    }),
    insert: jest.fn(() => ({
      values: jest.fn((v: any) => {
        const record = { id: randomUUID(), ...v };
        inserted.push(record);
        return { returning: async () => [record] };
      }),
    })),
  };

  const db = { transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { db, inserted, inputRef };
}

describe('PLAN-0113 Adaptive Daily Budget Pacing & Unused Hourly Redistribution', () => {
  const prevEnv = { ...process.env };
  beforeEach(() => {
    process.env.ADS_PAID_SERVING_ENABLED = 'true';
    process.env.ADS_PAID_RELEASE_ENABLED = 'true';
    process.env.ADS_AUCTION_POLICY_APPROVAL = JSON.stringify(POLICY);
    delete process.env.ADS_ADAPTIVE_PACING_BURST_MULTIPLIER;
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...prevEnv };
  });

  // ── Negative / boundary assertions first ───────────────────────────────────

  it('clamps invalid/zero daily budget and explicit zero hourly pacing safely to 0n', () => {
    const noonWat = new Date('2026-11-14T11:00:00.000Z');
    expect(
      computeEffectiveHourlyAllowanceNanos({
        dailyBudgetUsdCents: -100,
        hourlyPacingUsdCents: 21,
        dailyUsedNanos: 0n,
        hourlyUsedNanos: 0n,
        now: noonWat,
      }),
    ).toBe(0n);
    expect(
      computeEffectiveHourlyAllowanceNanos({
        dailyBudgetUsdCents: 0,
        hourlyPacingUsdCents: 21,
        dailyUsedNanos: 0n,
        hourlyUsedNanos: 0n,
        now: noonWat,
      }),
    ).toBe(0n);
    expect(
      computeEffectiveHourlyAllowanceNanos({
        dailyBudgetUsdCents: 500,
        hourlyPacingUsdCents: 0,
        dailyUsedNanos: 0n,
        hourlyUsedNanos: 0n,
        now: noonWat,
      }),
    ).toBe(0n);
  });

  it('returns 0n when prior hours already exhausted the daily budget', () => {
    const noonWat = new Date('2026-11-14T11:00:00.000Z');
    const allowance = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 5_000_000_000n,
      hourlyUsedNanos: 0n,
      now: noonWat,
    });
    expect(allowance).toBe(0n);
  });

  it('AdOpportunityService.reserve() rejects requests exceeding redistributed hourly allowance with adaptive telemetry and zero DB writes', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-14T05:00:00.000Z')); // 06:00 WAT -> 18h remaining -> $0.277777777/hr
    const input = makeOpportunityInput();
    const { db, inserted, inputRef } = makeReserveDbStub({
      outstanding: '200000000',
      daily: '200000000',
      hourly: '200000000', // $0.20 + $0.10 = $0.30 > $0.277777777
      frequency: 1,
    });
    Object.assign(inputRef, {
      campaignId: input.campaignId,
      creativeId: input.creativeId,
      submissionId: input.submissionId,
      promoterId: input.promoterId,
      websiteId: input.websiteId,
      slotId: input.slotId,
    });

    const service = new AdOpportunityService(db);
    await expect(service.reserve(input)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'HOURLY_PACING_EXHAUSTED',
        capacityDetails: {
          limitType: 'hourly_pacing',
          allowanceNanos: '277777777',
          usedOrReservedNanos: '200000000',
          requestedNanos: '100000000',
          availableNanos: '77777777',
          pacingMode: 'adaptive',
          baseHourlyAllowanceNanos: '210000000',
          watHour: 6,
          remainingWatHours: 18,
        },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it('preserves independent escrow, daily budget, and frequency controls even when adaptive hourly allowance has headroom', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-14T19:00:00.000Z')); // 20:00 WAT -> 4h remaining (ample hourly headroom)

    // Daily budget exhausted
    {
      const input = makeOpportunityInput();
      const { db, inserted, inputRef } = makeReserveDbStub({
        outstanding: '4950000000',
        daily: '4950000000',
        hourly: '0',
        frequency: 0,
      });
      Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });
      await expect(new AdOpportunityService(db).reserve(input)).rejects.toMatchObject({
        response: { code: 'DAILY_BUDGET_EXHAUSTED' },
      });
      expect(inserted).toHaveLength(0);
    }

    // Escrow exhausted
    {
      const input = makeOpportunityInput();
      const { db, inserted, inputRef } = makeReserveDbStub(
        { outstanding: '150000000', daily: '0', hourly: '0', frequency: 0 },
        { remainingBudgetUsdCents: 20 },
        { allocatedUsdCents: 5000, consumedUsdCents: 4980, refundedUsdCents: 0 },
      );
      Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });
      await expect(new AdOpportunityService(db).reserve(input)).rejects.toMatchObject({
        response: { code: 'INSUFFICIENT_RESERVABLE_ESCROW' },
      });
      expect(inserted).toHaveLength(0);
    }

    // Visitor frequency cap exhausted
    {
      const input = makeOpportunityInput();
      const { db, inserted, inputRef } = makeReserveDbStub({
        outstanding: '0',
        daily: '0',
        hourly: '0',
        frequency: 20,
      });
      Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });
      await expect(new AdOpportunityService(db).reserve(input)).rejects.toMatchObject({
        response: { code: 'FREQUENCY_CAP_REACHED' },
      });
      expect(inserted).toHaveLength(0);
    }
  });

  // ── Redistribution & valid behavior assertions ──────────────────────────────

  it('redistributes unused capacity from 6 quiet WAT hours ($5.00 / 18 = $0.277777777/hr)', () => {
    const sixAmWat = new Date('2026-11-14T05:00:00.000Z');
    expect(getWatHour(sixAmWat)).toBe(6);

    const details = computeAdaptiveHourlyPacingDetails({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 0n,
      hourlyUsedNanos: 0n,
      now: sixAmWat,
    });

    expect(details.effectiveHourlyAllowanceNanos).toBe(5_000_000_000n / 18n);
    expect(details.effectiveHourlyAllowanceNanos! > 21n * NANO_CENT).toBe(true);
    expect(details.mode).toBe('adaptive');
    expect(details.remainingWatHours).toBe(18);
  });

  it('holds allowance constant within an active WAT hour despite intra-hour spend and recalculates cleanly in subsequent hours', () => {
    const hour07 = new Date('2026-11-14T06:15:00.000Z'); // 07:15 WAT -> 17h remaining
    const startOfHour07 = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 200_000_000n,
      hourlyUsedNanos: 0n,
      now: hour07,
    });
    const midHour07 = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 300_000_000n,
      hourlyUsedNanos: 100_000_000n, // same $0.20 prior-hour spend
      now: hour07,
    });
    expect(startOfHour07).toBe(4_800_000_000n / 17n);
    expect(midHour07).toBe(startOfHour07);
  });

  it('enforces burst protection for >1h remaining and permits full remaining catch-up at 23:00 WAT', () => {
    const tenPmWat = new Date('2026-11-14T21:00:00.000Z'); // 22:00 WAT -> 2h remaining
    expect(getWatHour(tenPmWat)).toBe(22);
    expect(
      computeEffectiveHourlyAllowanceNanos({
        dailyBudgetUsdCents: 500,
        hourlyPacingUsdCents: 21,
        dailyUsedNanos: 0n,
        hourlyUsedNanos: 0n,
        now: tenPmWat,
        maxBurstMultiplier: 3n,
      }),
    ).toBe(630_000_000n);

    const finalWatHour = new Date('2026-11-14T22:30:00.000Z'); // 23:30 WAT -> 1h remaining
    expect(getWatHour(finalWatHour)).toBe(23);
    expect(
      computeEffectiveHourlyAllowanceNanos({
        dailyBudgetUsdCents: 500,
        hourlyPacingUsdCents: 21,
        dailyUsedNanos: 1_000_000_000n,
        hourlyUsedNanos: 0n,
        now: finalWatHour,
        maxBurstMultiplier: 3n,
      }),
    ).toBe(4_000_000_000n);
  });

  it('resets cleanly at 00:00 WAT (24 remaining hours) without carrying over prior day unspent budget', () => {
    const midnightWat = new Date('2026-11-14T23:00:00.000Z'); // 00:00 WAT next day
    expect(getWatHour(midnightWat)).toBe(0);

    const allowance = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 0n,
      hourlyUsedNanos: 0n,
      now: midnightWat,
    });
    expect(allowance).toBe(5_000_000_000n / 24n);
  });

  it('AdOpportunityService.reserve() allows reservation above static $0.21 cap using redistributed quiet-hour capacity', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-11-14T07:00:00.000Z')); // 08:00 WAT -> 16h remaining -> $5.00 / 16 = $0.3125/hr
    const input = makeOpportunityInput();
    const { db, inserted, inputRef } = makeReserveDbStub({
      outstanding: '200000000',
      daily: '200000000',
      hourly: '200000000', // $0.20 + $0.10 = $0.30 <= $0.3125/hr (would fail under static $0.21!)
      frequency: 1,
    });
    Object.assign(inputRef, {
      campaignId: input.campaignId,
      creativeId: input.creativeId,
      submissionId: input.submissionId,
      promoterId: input.promoterId,
      websiteId: input.websiteId,
      slotId: input.slotId,
    });

    const receipt = await new AdOpportunityService(db).reserve(input);
    expect(receipt).toBeDefined();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].state).toBe('HELD');
  });

  it('AuctionEngineService aligns with adaptive hourly pacing when daily budget and day spend are supplied while preserving static cap when omitted', () => {
    const engine = new AuctionEngineService();
    const baseCandidate = {
      campaignId: 'camp-1',
      creativeId: 'cre-1',
      ownerId: 'adv-1',
      status: 'active',
      moderationStatus: 'approved',
      creativeModerationStatus: 'approved',
      headline: 'Adaptive Ad',
      destinationUrl: 'https://example.test',
      pricingModel: 'cpc' as const,
      pricingVersion: 2,
      costPerImpressionUsdCents: 50,
      costPerClickUsdCents: 10,
      remainingBudgetUsdCents: 4970,
      hourlyPacingUsdCents: 21,
      currentHourSpendUsdCents: 25, // exceeds static $0.21, within $0.3125 at 08:00 WAT
      format: 'banner',
    };

    const adaptiveTime = new Date('2026-11-14T07:00:00.000Z'); // 08:00 WAT
    const excludedLegacy: any[] = [];
    const legacyResult = engine.resolveAuction(
      [baseCandidate],
      { slotHandle: 'banner_main', requestedAt: adaptiveTime },
      null,
      excludedLegacy,
    );
    expect(legacyResult).toBeNull();
    expect(excludedLegacy).toEqual([
      expect.objectContaining({ reasonCode: 'HOURLY_PACING_EXHAUSTED' }),
    ]);

    const excludedAdaptive: any[] = [];
    const adaptiveWinner = engine.resolveAuction(
      [{ ...baseCandidate, dailyBudgetUsdCents: 500, currentDaySpendUsdCents: 25 }],
      { slotHandle: 'banner_main', requestedAt: adaptiveTime },
      null,
      excludedAdaptive,
    );
    expect(adaptiveWinner?.decisionSnapshot.winnerCampaignId).toBe('camp-1');
    expect(excludedAdaptive).toEqual([]);
  });
});
