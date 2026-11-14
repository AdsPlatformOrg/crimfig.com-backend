import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_WINDOW_MS, INGEST_TOLERANCE_MS } from '@crimfig/shared';
import { randomUUID } from 'crypto';
import { AdOpportunityService } from '../../../api/billing-api/src/modules/ecosystem/ad-opportunity.service';
import { OpportunityClient, OpportunityConflictError } from '../../../api/ads-api/src/modules/billing/opportunity-client';
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

function makeInput(overrides: Partial<Record<string, any>> = {}) {
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

function makeDbStub(usage: { outstanding: string; daily: string; hourly: string; frequency: number }, campaignOverrides: Record<string, any> = {}, escrowOverrides: Record<string, any> = {}) {
  const inserted: any[] = [];
  const inputRef = { campaignId: '', creativeId: '', submissionId: '', promoterId: '', websiteId: '', slotId: '', advertiserId: randomUUID(), promoterUserId: randomUUID() };
  const tx: any = {
    execute: jest.fn(async (q: any) => {
      const sqlText = JSON.stringify(q);
      if (sqlText.includes('ads_traffic_controls')) return { rows: [] };
      if (sqlText.includes('ads_opportunity_reservations') && sqlText.includes('outstanding')) return { rows: [usage] };
      if (sqlText.includes('ads_settlement_carries')) return { rows: [{ nanos: '0' }] };
      return { rows: [] };
    }),
    select: jest.fn(() => {
      let tableIndex = 0;
      const chain: any = {
        from: jest.fn((t: any) => {
          tableIndex = Object.keys(t || {}).length;
          return chain;
        }),
        innerJoin: jest.fn(() => chain),
        where: jest.fn(() => chain),
        for: jest.fn(() => chain),
        limit: jest.fn(async () => {
          // Return appropriate row based on call order via call count
          return [];
        }),
      };
      return chain;
    }),
    insert: jest.fn(() => ({
      values: jest.fn((v: any) => {
        inserted.push(v);
        return { returning: async () => [{ id: randomUUID(), ...v }] };
      }),
    })),
  };

  let selectCall = 0;
  tx.select = jest.fn(() => {
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
        if (call === 2) return []; // prior reservation
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
  });

  const db = { transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { db, inserted, inputRef };
}

describe('PLAN-0112 granular Billing capacity conflict codes', () => {
  const prevEnv = { ...process.env };
  beforeEach(() => {
    process.env.ADS_PAID_SERVING_ENABLED = 'true';
    process.env.ADS_PAID_RELEASE_ENABLED = 'true';
    process.env.ADS_AUCTION_POLICY_APPROVAL = JSON.stringify(POLICY);
  });
  afterEach(() => {
    process.env = { ...prevEnv };
  });

  it('rejects with HOURLY_PACING_EXHAUSTED and exact $0.21/$0.20/$0.10/$0.01 telemetry without inserting reservation', async () => {
    const input = makeInput();
    const { db, inserted, inputRef } = makeDbStub({
      outstanding: '200000000',
      daily: '200000000',
      hourly: '200000000', // $0.20 used/reserved out of $0.21
      frequency: 1,
    });
    inputRef.campaignId = input.campaignId;
    inputRef.creativeId = input.creativeId;
    inputRef.submissionId = input.submissionId;
    inputRef.promoterId = input.promoterId;
    inputRef.websiteId = input.websiteId;
    inputRef.slotId = input.slotId;

    const service = new AdOpportunityService(db);
    await expect(service.reserve(input)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'HOURLY_PACING_EXHAUSTED',
        capacityDetails: {
          limitType: 'hourly_pacing',
          unit: 'usd_nanos',
          allowanceNanos: '210000000',
          usedOrReservedNanos: '200000000',
          requestedNanos: '100000000',
          availableNanos: '10000000',
          decision: 'rejected_house_fallback',
        },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it('rejects with DAILY_BUDGET_EXHAUSTED before hourly pacing when daily budget is exceeded', async () => {
    const input = makeInput();
    const { db, inserted, inputRef } = makeDbStub({
      outstanding: '4950000000',
      daily: '4950000000', // $4.95 of $5.00
      hourly: '0',
      frequency: 1,
    });
    Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });

    const service = new AdOpportunityService(db);
    await expect(service.reserve(input)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'DAILY_BUDGET_EXHAUSTED',
        capacityDetails: {
          limitType: 'daily_budget',
          allowanceNanos: '5000000000',
          usedOrReservedNanos: '4950000000',
          availableNanos: '50000000',
        },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it('rejects with INSUFFICIENT_RESERVABLE_ESCROW when outstanding holds consume remaining escrow', async () => {
    const input = makeInput();
    const { db, inserted, inputRef } = makeDbStub(
      { outstanding: '1950000000', daily: '0', hourly: '0', frequency: 0 },
      { remainingBudgetUsdCents: 200 },
      { allocatedUsdCents: 500, consumedUsdCents: 300, refundedUsdCents: 0 },
    );
    Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });

    const service = new AdOpportunityService(db);
    await expect(service.reserve(input)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'INSUFFICIENT_RESERVABLE_ESCROW',
        capacityDetails: {
          limitType: 'reservable_escrow',
          allowanceNanos: '2000000000',
          usedOrReservedNanos: '1950000000',
          availableNanos: '50000000',
        },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it('rejects with FREQUENCY_CAP_REACHED when visitor reaches daily frequency cap', async () => {
    const input = makeInput();
    const { db, inserted, inputRef } = makeDbStub({
      outstanding: '0',
      daily: '0',
      hourly: '0',
      frequency: 20,
    });
    Object.assign(inputRef, { campaignId: input.campaignId, creativeId: input.creativeId, submissionId: input.submissionId, promoterId: input.promoterId, websiteId: input.websiteId, slotId: input.slotId });

    const service = new AdOpportunityService(db);
    await expect(service.reserve(input)).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'FREQUENCY_CAP_REACHED',
        capacityDetails: {
          limitType: 'frequency_cap',
          unit: 'impressions_per_day',
          allowanceCount: 20,
          usedCount: 20,
          requestedCount: 1,
          availableCount: 0,
        },
      },
    });
    expect(inserted).toHaveLength(0);
  });

  it('OpportunityClient parses granular 409 code and capacityDetails', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 409,
      ok: false,
      json: async () => ({
        statusCode: 409,
        code: 'HOURLY_PACING_EXHAUSTED',
        capacityDetails: {
          limitType: 'hourly_pacing',
          unit: 'usd_nanos',
          allowanceNanos: '210000000',
          usedOrReservedNanos: '200000000',
          requestedNanos: '100000000',
          availableNanos: '10000000',
          decision: 'rejected_house_fallback',
        },
      }),
    }));
    const originalFetch = global.fetch;
    (global as any).fetch = fetchMock;
    try {
      const client = new OpportunityClient(new ConfigService({ BILLING_API_URL: 'http://127.0.0.1:3008/api/v1', INTERNAL_ECOSYSTEM_KEY: 'test-key' }));
      await expect(client.reserve(makeInput())).rejects.toMatchObject({
        reasonCode: 'HOURLY_PACING_EXHAUSTED',
        capacityDetails: {
          limitType: 'hourly_pacing',
          allowanceNanos: '210000000',
          usedOrReservedNanos: '200000000',
          availableNanos: '10000000',
        },
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

