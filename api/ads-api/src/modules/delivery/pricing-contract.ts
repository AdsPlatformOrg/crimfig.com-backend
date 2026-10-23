/** JED-approved v2: CPM = USD per 1,000 eligible impressions; CPC = USD per eligible click. */
export const AD_PRICING_VERSION = 2;
export const NANOS_PER_USD_CENT = 10_000_000n;
export function auctionScoreMicros(model: 'cpm' | 'cpc', bidCents: number): number {
  if (!Number.isSafeInteger(bidCents) || bidCents < 1 || bidCents > 2147483647 || !['cpm', 'cpc'].includes(model)) throw new RangeError('Invalid versioned ad bid');
  // eCPM in micro-USD. CPC ranking assumes 15 clicks per 1,000 impressions (1.5% CTR).
  return Number(BigInt(bidCents) * 10_000n * (model === 'cpc' ? 15n : 1n));
}
export function eventPriceNanos(model: 'cpm' | 'cpc', clearingEcpmMicros: number): bigint {
  if (!Number.isSafeInteger(clearingEcpmMicros) || clearingEcpmMicros <= 0 || !['cpm', 'cpc'].includes(model)) throw new RangeError('Invalid clearing price');
  // CPM: micros * 1000 nanos/micro / 1000 impressions. CPC: divide by 15 expected clicks.
  // Floor the sub-nano remainder so the realized charge never exceeds the winning bid.
  return model === 'cpm' ? BigInt(clearingEcpmMicros) : BigInt(clearingEcpmMicros) * 1000n / 15n;
}
/** Whole-cent settlement with durable fractional carry; rounding per event would erase CPM earnings. */
export function settleNanos(previousCarry: bigint, eventPrices: readonly bigint[]) {
  if (previousCarry < 0n || previousCarry >= NANOS_PER_USD_CENT || eventPrices.some(price => price < 0n)) throw new RangeError('Invalid settlement precision');
  const total = eventPrices.reduce((sum, price) => sum + price, previousCarry);
  const cents = total / NANOS_PER_USD_CENT;
  if (cents > 2147483647n) throw new RangeError('Settlement exceeds wallet limit');
  return { cents: Number(cents), carryNanos: total % NANOS_PER_USD_CENT };
}
