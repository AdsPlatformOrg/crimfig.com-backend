import * as crypto from 'crypto';

/** JED-approved v2: CPM = USD per 1,000 eligible impressions; CPC = USD per eligible click. */
export const AD_PRICING_VERSION = 2;
export const NANOS_PER_USD_CENT = 10_000_000n;
export const DEFAULT_AUCTION_POLICY_VERSION = 'auction_v1';

/**
 * Canonical pricing floors from backend/shared/src/config/financial-constants.json:
 * - baseCpmUsdCents = 50 ($0.50 per 1,000 viewable impressions = 500,000 eCPM micros = 500,000 nanos/impression)
 * - baseCpcUsdCents = 10 ($0.10 per click = 1,500,000 eCPM micros at 1.5% CTR = 100,000,000 nanos/click)
 */
export const BASE_CPM_FLOOR_CENTS = 50;
export const BASE_CPC_FLOOR_CENTS = 10;
export const BASE_CPM_FLOOR_MICROS = 500_000; // $0.50 eCPM in micro-USD
export const BASE_CPC_FLOOR_MICROS = 1_500_000; // $0.10 CPC at 1.5% CTR = $1.50 eCPM in micro-USD
export const BASE_CPM_FLOOR_NANOS = 500_000n; // $0.0005 per viewable impression
export const BASE_CPC_FLOOR_NANOS = 100_000_000n; // $0.10 per click

export function reservePriceMicrosForModel(model: 'cpm' | 'cpc'): number {
  return model === 'cpc' ? BASE_CPC_FLOOR_MICROS : BASE_CPM_FLOOR_MICROS;
}

export function isBidAboveModelFloor(model: 'cpm' | 'cpc', bidCents: number): boolean {
  if (!Number.isSafeInteger(bidCents) || bidCents <= 0) return false;
  return model === 'cpc'
    ? bidCents >= BASE_CPC_FLOOR_CENTS
    : bidCents >= BASE_CPM_FLOOR_CENTS;
}

export function auctionScoreMicros(model: 'cpm' | 'cpc', bidCents: number): number {
  if (!Number.isSafeInteger(bidCents) || bidCents < 1 || bidCents > 2147483647 || !['cpm', 'cpc'].includes(model)) {
    throw new RangeError('Invalid versioned ad bid');
  }
  // eCPM in micro-USD. CPC ranking assumes 15 clicks per 1,000 impressions (1.5% CTR).
  return Number(BigInt(bidCents) * 10_000n * (model === 'cpc' ? 15n : 1n));
}

export function eventPriceNanos(model: 'cpm' | 'cpc', clearingEcpmMicros: number): bigint {
  if (!Number.isSafeInteger(clearingEcpmMicros) || clearingEcpmMicros <= 0 || !['cpm', 'cpc'].includes(model)) {
    throw new RangeError('Invalid clearing price');
  }
  // CPM: micros * 1000 nanos/micro / 1000 impressions. CPC: divide by 15 expected clicks.
  // Floor the sub-nano remainder so the realized charge never exceeds the winning bid.
  return model === 'cpm' ? BigInt(clearingEcpmMicros) : (BigInt(clearingEcpmMicros) * 1000n) / 15n;
}

/** Whole-cent settlement with durable fractional carry; rounding per event would erase CPM earnings. */
export function settleNanos(previousCarry: bigint, eventPrices: readonly bigint[]) {
  if (previousCarry < 0n || previousCarry >= NANOS_PER_USD_CENT || eventPrices.some((price) => price < 0n)) {
    throw new RangeError('Invalid settlement precision');
  }
  const total = eventPrices.reduce((sum, price) => sum + price, previousCarry);
  const cents = total / NANOS_PER_USD_CENT;
  if (cents > 2147483647n) throw new RangeError('Settlement exceeds wallet limit');
  return { cents: Number(cents), carryNanos: total % NANOS_PER_USD_CENT };
}

/**
 * Deterministic SHA-256 tie-breaker digest so equal-score candidates resolve
 * identically on replay without favoring insertion order or random numbers.
 */
export function deterministicTieDigest(
  tieSeed: string,
  campaignId: string,
  creativeId: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${tieSeed}:${campaignId}:${creativeId}`)
    .digest('hex');
}
