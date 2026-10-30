import {
  AD_PRICING_VERSION,
  auctionScoreMicros,
  BASE_CPC_FLOOR_CENTS,
  BASE_CPC_FLOOR_MICROS,
  BASE_CPM_FLOOR_CENTS,
  BASE_CPM_FLOOR_MICROS,
  deterministicTieDigest,
  eventPriceNanos,
  isBidAboveModelFloor,
  NANOS_PER_USD_CENT,
  reservePriceMicrosForModel,
  settleNanos,
} from '../../../api/ads-api/src/modules/delivery/pricing-contract';
import {
  AuctionCandidate,
  AuctionEngineService,
} from '../../../api/ads-api/src/modules/delivery/auction-engine.service';

const baseCandidate: AuctionCandidate = {
  campaignId: '11111111-1111-4111-8111-111111111111',
  creativeId: '22222222-2222-4222-8222-222222222222',
  ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  category: 'Technology',
  status: 'active',
  moderationStatus: 'approved',
  creativeModerationStatus: 'approved',
  headline: 'ad',
  destinationUrl: 'https://example.test',
  pricingVersion: AD_PRICING_VERSION,
  pricingModel: 'cpm',
  costPerImpressionUsdCents: 500, // $5.00 CPM -> 5,000,000 micros
  costPerClickUsdCents: 10, // $0.10 CPC -> 1,500,000 micros
  remainingBudgetUsdCents: 10000,
  format: 'card',
};

describe('Ad Pricing & Auction Engine Security Invariants (PLAN-0047 / PLAN-0049)', () => {
  test('standard CPM charges one thousandth of quoted CPM per eligible impression', () => {
    const score = auctionScoreMicros('cpm', 500); // $5 per thousand
    const price = eventPriceNanos('cpm', score);
    expect(price).toBe(5_000_000n); // $0.005 each, not $5 each
    expect(settleNanos(0n, Array(1000).fill(price))).toEqual({
      cents: 500,
      carryNanos: 0n,
    });
  });

  test('CPC normalization is for ranking only; an eligible click retains its actual bid ceiling', () => {
    const score = auctionScoreMicros('cpc', 10);
    expect(score).toBe(1_500_000); // $1.50 eCPM at 1.5% CTR
    expect(eventPriceNanos('cpc', score)).toBe(100_000_000n); // $0.10 per click
  });

  test('canonical model floors match financial-constants.json ($0.50 CPM, $0.10 CPC)', () => {
    expect(BASE_CPM_FLOOR_CENTS).toBe(50);
    expect(BASE_CPC_FLOOR_CENTS).toBe(10);
    expect(reservePriceMicrosForModel('cpm')).toBe(BASE_CPM_FLOOR_MICROS);
    expect(reservePriceMicrosForModel('cpc')).toBe(BASE_CPC_FLOOR_MICROS);
    expect(isBidAboveModelFloor('cpm', 49)).toBe(false);
    expect(isBidAboveModelFloor('cpm', 50)).toBe(true);
    expect(isBidAboveModelFloor('cpc', 9)).toBe(false);
    expect(isBidAboveModelFloor('cpc', 10)).toBe(true);
  });

  test('fractional CPM settlement carries value rather than rounding every impression to zero', () => {
    const price = eventPriceNanos('cpm', auctionScoreMicros('cpm', 1));
    const first = settleNanos(0n, Array(999).fill(price));
    expect(first).toEqual({ cents: 0, carryNanos: 9_990_000n });
    expect(settleNanos(first.carryNanos, [price])).toEqual({
      cents: 1,
      carryNanos: 0n,
    });
  });

  test('pricing rejects unsupported models, invalid bids and overflow', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
      expect(() => auctionScoreMicros('cpm', value)).toThrow();
    }
    expect(() => eventPriceNanos('cpa' as any, 100)).toThrow();
    expect(() => settleNanos(-1n, [])).toThrow();
    expect(() => settleNanos(0n, [2147483648n * 10_000_000n])).toThrow();
  });

  test('auction never adopts historical pricing, below-floor bids, or unknown targeting as a match', () => {
    const auction = new AuctionEngineService();
    expect(
      auction.resolveAuction(
        [{ ...baseCandidate, pricingVersion: 1 }],
        { slotHandle: 'slot' },
      ),
    ).toBeNull();
    expect(
      auction.resolveAuction(
        [{ ...baseCandidate, costPerImpressionUsdCents: 49 }],
        { slotHandle: 'slot' },
      ),
    ).toBeNull();
    expect(
      auction.resolveAuction(
        [{ ...baseCandidate, targetCountries: ['NG'] }],
        { slotHandle: 'slot' },
      ),
    ).toBeNull();
    expect(
      auction.resolveAuction(
        [{ ...baseCandidate, targetDevices: ['ios'] }],
        { slotHandle: 'slot' },
      ),
    ).toBeNull();
  });

  test('mixed CPM/CPC ranking yields a capped per-event immutable price', () => {
    const auction = new AuctionEngineService();
    const winner = auction.resolveAuction(
      [
        baseCandidate,
        {
          ...baseCandidate,
          campaignId: '33333333-3333-4333-8333-333333333333',
          ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          pricingModel: 'cpc',
          costPerClickUsdCents: 100,
        },
      ],
      { slotHandle: 'slot' },
    );
    expect(winner?.winner.campaignId).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
    expect(winner?.clearingPriceMicros).toBe(5_000_001);
    expect(winner!.billingPriceNanos).toBeLessThanOrEqual(1_000_000_000n);
  });

  test('single eligible bidder clears at canonical model reserve floor, never at $0.0001', () => {
    const auction = new AuctionEngineService();
    const cpmSingle = auction.resolveAuction([baseCandidate], {
      slotHandle: 'slot',
    });
    expect(cpmSingle?.clearingPriceMicros).toBe(BASE_CPM_FLOOR_MICROS); // 500,000 ($0.50 CPM)
    expect(cpmSingle?.billingPriceNanos).toBe(500_000n); // $0.0005 per impression

    const cpcSingle = auction.resolveAuction(
      [
        {
          ...baseCandidate,
          pricingModel: 'cpc',
          costPerClickUsdCents: 25, // $0.25 CPC
        },
      ],
      { slotHandle: 'slot' },
    );
    expect(cpcSingle?.clearingPriceMicros).toBe(BASE_CPC_FLOOR_MICROS); // 1,500,000 ($0.10 CPC floor)
    expect(cpcSingle?.billingPriceNanos).toBe(100_000_000n); // $0.10 per click
  });

  test('bidder grouping prevents multiple creatives from the same advertiser or campaign from self-inflating second price', () => {
    const auction = new AuctionEngineService();
    const result = auction.resolveAuction(
      [
        {
          ...baseCandidate,
          campaignId: 'camp-high',
          creativeId: 'creative-1',
          ownerId: 'same-advertiser',
          costPerImpressionUsdCents: 1000, // $10 CPM
        },
        {
          ...baseCandidate,
          campaignId: 'camp-second-same-owner',
          creativeId: 'creative-2',
          ownerId: 'same-advertiser',
          costPerImpressionUsdCents: 900, // $9 CPM from same owner
        },
      ],
      { slotHandle: 'slot', bidderGroupingMode: 'advertiser' },
    );
    expect(result?.winner.creativeId).toBe('creative-1');
    expect(result?.runnerUp).toBeNull();
    // Should clear at the $0.50 CPM floor, NOT at $9.000001 CPM!
    expect(result?.clearingPriceMicros).toBe(BASE_CPM_FLOOR_MICROS);
    expect(result?.decisionSnapshot.excludedCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          creativeId: 'creative-2',
          reasonCode: 'SAME_BIDDER_SECONDARY_CREATIVE',
        }),
      ]),
    );
  });

  test('deterministic tie-breaking and replayAuctionDecision verify tamper-evident snapshot hashes', () => {
    const auction = new AuctionEngineService();
    const candidates: AuctionCandidate[] = [
      {
        ...baseCandidate,
        campaignId: 'camp-a',
        creativeId: 'cre-a',
        ownerId: 'owner-a',
        costPerImpressionUsdCents: 300,
      },
      {
        ...baseCandidate,
        campaignId: 'camp-b',
        creativeId: 'cre-b',
        ownerId: 'owner-b',
        costPerImpressionUsdCents: 300,
      },
    ];
    const ctx = {
      slotHandle: 'cf-slot-network-1234',
      requestId: '99999999-9999-4999-8999-999999999999',
      requestedAt: new Date('2026-10-30T12:00:00Z'),
    };
    const first = auction.resolveAuction(candidates, ctx);
    const reversed = auction.resolveAuction([...candidates].reverse(), ctx);
    expect(first?.winner.campaignId).toBe(reversed?.winner.campaignId);
    expect(first?.decisionSnapshot.recordHash).toBe(
      reversed?.decisionSnapshot.recordHash,
    );

    const replay = auction.replayAuctionDecision(
      candidates,
      ctx,
      first!.decisionSnapshot,
    );
    expect(replay.matches).toBe(true);
    expect(replay.mismatches).toEqual([]);

    // Tamper with snapshot clearingPriceMicros -> integrity check must fail
    const tampered = {
      ...first!.decisionSnapshot,
      clearingPriceMicros: first!.decisionSnapshot.clearingPriceMicros + 100,
    };
    expect(auction.verifyDecisionSnapshotIntegrity(tampered)).toBe(false);
    const failedReplay = auction.replayAuctionDecision(
      candidates,
      ctx,
      tampered,
    );
    expect(failedReplay.matches).toBe(false);
    expect(failedReplay.mismatches.length).toBeGreaterThan(0);
  });

  test('per-opportunity exposure reservation prevents over-issuing unbacked payable tokens and expires stale holds', () => {
    const auction = new AuctionEngineService();
    const now = new Date('2026-10-30T12:00:00Z');
    // Campaign has only $0.10 remaining (10 cents = 100,000,000 nanos), enough for exactly 1 CPC click at $0.10
    const tightCpcCandidate: AuctionCandidate = {
      ...baseCandidate,
      campaignId: 'camp-tight-budget',
      ownerId: 'owner-tight',
      pricingModel: 'cpc',
      costPerClickUsdCents: 10,
      remainingBudgetUsdCents: 10,
    };

    const res1 = auction.reserveSimulatedOpportunityExposure({
      opportunityId: 'opp-1',
      campaignId: 'camp-tight-budget',
      remainingBudgetUsdCents: 10,
      pricingModel: 'cpc',
      reservedNanos: 100_000_000n,
      ttlMs: 60_000,
      now,
    });
    expect(res1.state).toBe('HELD');

    // Second concurrent auction at the same timestamp must exclude camp-tight-budget with INSUFFICIENT_AVAILABLE_EXPOSURE
    const secondAuction = auction.resolveAuction([tightCpcCandidate], {
      slotHandle: 'slot',
      requestedAt: now,
    });
    expect(secondAuction).toBeNull();

    // After 61 seconds (past TTL), the un-claimed hold expires and the budget becomes available again
    const afterExpiry = new Date(now.getTime() + 61_000);
    const thirdAuction = auction.resolveAuction([tightCpcCandidate], {
      slotHandle: 'slot',
      requestedAt: afterExpiry,
    });
    expect(thirdAuction?.winner.campaignId).toBe('camp-tight-budget');
  });
});
