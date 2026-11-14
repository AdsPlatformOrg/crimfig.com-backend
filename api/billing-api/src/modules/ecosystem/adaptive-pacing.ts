import { NANO_CENT } from '@crimfig/shared';

export interface AdaptiveHourlyPacingInput {
  dailyBudgetUsdCents: number | null | undefined;
  hourlyPacingUsdCents: number | null | undefined;
  dailyUsedNanos: bigint;
  hourlyUsedNanos: bigint;
  now?: Date;
  maxBurstMultiplier?: bigint;
}

/**
 * Returns the current hour (0..23) in Africa/Lagos (WAT, UTC+1, no DST).
 */
export function getWatHour(now: Date = new Date()): number {
  const watMs = now.getTime() + 60 * 60 * 1000;
  return new Date(watMs).getUTCHours();
}

/**
 * Computes the effective hourly spending allowance in USD nanos (`10^7` nanos = 1 cent).
 * Redistributes unused daily budget from elapsed WAT hours evenly across remaining hours
 * of the current WAT day, bounded by remaining daily budget and optional burst protection.
 */
export function computeEffectiveHourlyAllowanceNanos(
  input: AdaptiveHourlyPacingInput,
): bigint | null {
  const explicitHourlyNanos =
    input.hourlyPacingUsdCents != null ? BigInt(input.hourlyPacingUsdCents) * NANO_CENT : null;

  if (input.dailyBudgetUsdCents == null) {
    return explicitHourlyNanos;
  }
  if (input.hourlyPacingUsdCents == null) {
    return null;
  }

  const dailyBudgetNanos = BigInt(input.dailyBudgetUsdCents) * NANO_CENT;
  const watHour = getWatHour(input.now);
  const remainingHours = BigInt(Math.max(1, 24 - watHour));

  const dailyUsedBeforeCurrentHourNanos =
    input.dailyUsedNanos > input.hourlyUsedNanos ? input.dailyUsedNanos - input.hourlyUsedNanos : 0n;

  const remainingDailyAtHourStartNanos =
    dailyBudgetNanos > dailyUsedBeforeCurrentHourNanos
      ? dailyBudgetNanos - dailyUsedBeforeCurrentHourNanos
      : 0n;

  let redistributedNanos = remainingDailyAtHourStartNanos / remainingHours;

  const burstMultiplier = input.maxBurstMultiplier ?? 3n;
  if (remainingHours > 1n && burstMultiplier > 0n) {
    const baselineHourlyNanos = dailyBudgetNanos / 24n;
    const burstCapNanos =
      explicitHourlyNanos != null && explicitHourlyNanos > baselineHourlyNanos
        ? explicitHourlyNanos * burstMultiplier
        : baselineHourlyNanos * burstMultiplier;
    if (redistributedNanos > burstCapNanos) {
      redistributedNanos = burstCapNanos;
    }
  }

  if (redistributedNanos > remainingDailyAtHourStartNanos) {
    redistributedNanos = remainingDailyAtHourStartNanos;
  }

  return redistributedNanos;
}

