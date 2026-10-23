import { auctionScoreMicros, eventPriceNanos, settleNanos } from '../../../api/ads-api/src/modules/delivery/pricing-contract';
import { AuctionEngineService } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';

test('standard CPM charges one thousandth of quoted CPM per eligible impression', () => {
  const score = auctionScoreMicros('cpm', 500); // $5 per thousand
  const price = eventPriceNanos('cpm', score);
  expect(price).toBe(5_000_000n); // $0.005 each, not $5 each
  expect(settleNanos(0n, Array(1000).fill(price))).toEqual({ cents: 500, carryNanos: 0n });
});
test('CPC normalization is for ranking only; an eligible click retains its actual bid ceiling', () => {
  const score = auctionScoreMicros('cpc', 10);
  expect(score).toBe(1_500_000); // $1.50 eCPM at 1.5% CTR
  expect(eventPriceNanos('cpc', score)).toBe(100_000_000n); // $0.10 per click
});
test('fractional CPM settlement carries value rather than rounding every impression to zero', () => {
  const price = eventPriceNanos('cpm', auctionScoreMicros('cpm', 1));
  const first = settleNanos(0n, Array(999).fill(price));
  expect(first).toEqual({ cents: 0, carryNanos: 9_990_000n });
  expect(settleNanos(first.carryNanos, [price])).toEqual({ cents: 1, carryNanos: 0n });
});
test('pricing rejects unsupported models, invalid bids and overflow', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2147483648]) expect(() => auctionScoreMicros('cpm', value)).toThrow();
  expect(() => eventPriceNanos('cpa' as any, 100)).toThrow();
  expect(() => settleNanos(-1n, [])).toThrow();
  expect(() => settleNanos(0n, [2147483648n * 10_000_000n])).toThrow();
});
const candidate = { campaignId: 'campaign', creativeId: 'creative', headline: 'ad', destinationUrl: 'https://example.test',
  pricingVersion: 2, pricingModel: 'cpm' as const, costPerImpressionUsdCents: 500, costPerClickUsdCents: 10,
  remainingBudgetUsdCents: 10000, format: 'card' };
test('auction never adopts historical pricing or accepts unknown targeting as a match', () => {
  const auction = new AuctionEngineService();
  expect(auction.resolveAuction([{ ...candidate, pricingVersion: 1 }], { slotHandle: 'slot' })).toBeNull();
  expect(auction.resolveAuction([{ ...candidate, targetCountries: ['NG'] }], { slotHandle: 'slot' })).toBeNull();
  expect(auction.resolveAuction([{ ...candidate, targetDevices: ['ios'] }], { slotHandle: 'slot' })).toBeNull();
});
test('mixed CPM/CPC ranking yields a capped per-event immutable price', () => {
  const auction = new AuctionEngineService();
  const winner = auction.resolveAuction([candidate, { ...candidate, campaignId: 'cpc', pricingModel: 'cpc', costPerClickUsdCents: 100 }], { slotHandle: 'slot' });
  expect(winner?.winner.campaignId).toBe('cpc');
  expect(winner?.clearingPriceMicros).toBe(5_000_001);
  expect(winner!.billingPriceNanos).toBeLessThanOrEqual(1_000_000_000n);
});
