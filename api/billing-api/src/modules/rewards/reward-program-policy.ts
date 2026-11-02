import { BadRequestException, ConflictException } from "@nestjs/common";
import constants from "../../../../../shared/src/config/financial-constants.json";
export const MICRO_CFIG = 1_000_000n;
export function positive(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,17}$/.test(value))
    throw new BadRequestException("Positive integer units required");
  return BigInt(value);
}
export function conversionQuote(
  requested: string,
  cfigPerPoint: number,
  available: bigint,
  monthPoints: bigint,
) {
  const units = positive(requested);
  if (!Number.isSafeInteger(cfigPerPoint) || cfigPerPoint <= 0)
    throw new ConflictException("Approved cohort valuation required");
  const rate = BigInt(cfigPerPoint) * MICRO_CFIG,
    points = units / rate,
    debited = points * rate;
  if (
    points < BigInt(constants.fundedRewards.conversionMinimumPoints) ||
    points + monthPoints >
      BigInt(constants.fundedRewards.conversionMonthlyMaxPoints) ||
    debited > available
  )
    throw new ConflictException(
      "Conversion amount, balance or monthly cap is ineligible",
    );
  return { points, debited, residual: units - debited };
}
export function reserveFloor(fund: any, settings: any) {
  const values = [
    "cash_balance_usd_cents",
    "available_usd_cents",
    "allocated_usd_cents",
    "funded_pending_usd_cents",
  ];
  for (const key of values)
    if (!/^\d+$/.test(String(fund[key])))
      throw new ConflictException("Fund needs reconciliation");
  const cash = BigInt(fund.cash_balance_usd_cents),
    available = BigInt(fund.available_usd_cents),
    allocated = BigInt(fund.allocated_usd_cents),
    pending = BigInt(fund.funded_pending_usd_cents);
  if (cash !== available + allocated + pending)
    throw new ConflictException("Fund buckets do not reconcile");
  if (
    !Number.isSafeInteger(settings.reserve_floor_percent) ||
    settings.reserve_floor_percent < 0 ||
    settings.reserve_floor_percent > 100 ||
    !Number.isSafeInteger(settings.reserve_floor_min_cents) ||
    settings.reserve_floor_min_cents < 0
  )
    throw new ConflictException("Invalid approved reserve settings");
  const percent = (cash * BigInt(settings.reserve_floor_percent) + 99n) / 100n,
    minimum = BigInt(settings.reserve_floor_min_cents);
  const stored = BigInt(fund.reserve_floor_usd_cents ?? 0);
  return [percent, minimum, stored].reduce((a, b) => (a > b ? a : b));
}
export function gate(
  kind: "funding" | "paid" | "conversion",
  env = process.env,
) {
  const p = constants.fundedRewards;
  return (
    p.enabled &&
    (kind === "funding"
      ? p.fundingEnabled && env.BILLING_REWARDS_FUNDING_ENABLED === "true"
      : kind === "paid"
        ? env.BILLING_REWARDS_PAID_ENABLED === "true"
        : p.conversionEnabled &&
          constants.houseRewards.conversionEnabled &&
          env.BILLING_REWARDS_CONVERSION_ENABLED === "true")
  );
}
export const fundedPolicy = () => {
  if (constants.rewardsValuation.pointsPerUsd !== 100)
    throw new ConflictException(
      "Existing funded valuation requires reconciliation",
    );
  return structuredClone(constants.fundedRewards);
};

export class RewardCapacityUnavailable extends ConflictException {}
