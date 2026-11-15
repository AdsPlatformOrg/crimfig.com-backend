import { NANO_CENT } from '@crimfig/shared';

export interface AdaptiveHourlyPacingInput {
  dailyBudgetUsdCents: number | null | undefined;
  hourlyPacingUsdCents: number | null | undefined;
  dailyUsedNanos: bigint;
  hourlyUsedNanos: bigint;
  now?: Date;
  maxBurstMultiplier?: bigint;
}

export interface AdaptiveHourlyPacingEvaluation {
  effectiveHourlyAllowanceNanos: bigint | null;
  mode: 'adaptive' | 'fixed' | 'uncapped';
  watHour: number;
  remainingWatHours: number;
  baselineHourlyAllowanceNanos: bigint | null;
  dailyUsedBeforeCurrentHourNanos: bigint;
  remainingDailyAtHourStartNanos: bigint;
}

/**
 * Parses an optional burst multiplier env var (default 3x baseline).
 * Only '0' disables burst capping; invalid or negative values fall back to default (3n).
 */
export function parseAdaptiveBurstMultiplier(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.ADS_ADAPTIVE_PACING_BURST_MULTIPLIER?.trim();
  if (!raw) return 3n;
  if (!/^\d+$/.test(raw)) return 3n;
  const parsed = BigInt(raw);
  return parsed >= 0n && parsed <= 24n ? parsed : 3n;
}

/**
 * Returns the current hour (0..23) in Africa/Lagos (WAT, UTC+1, no DST).
 */
export function getWatHour(now: Date = new Date()): number {
  const watMs = now.getTime() + 60 * 60 * 1000;
  return new Date(watMs).getUTCHours();
}

/**
 * Evaluates the effective hourly spending allowance in USD nanos (`10^7` nanos = 1 cent).
 * Redistributes unused daily budget from elapsed WAT hours evenly across remaining hours
 * of the current WAT day, bounded by remaining daily budget and optional burst protection.
 */
export function computeAdaptiveHourlyPacingDetails(
  input: AdaptiveHourlyPacingInput,
): AdaptiveHourlyPacingEvaluation {
  const watHour = getWatHour(input.now);
  const remainingWatHours = Math.max(1, 24 - watHour);
  const explicitHourlyNanos =
    input.hourlyPacingUsdCents != null ? BigInt(Math.max(0, input.hourlyPacingUsdCents)) * NANO_CENT : null;

  if (input.dailyBudgetUsdCents == null) {
    return {
      effectiveHourlyAllowanceNanos: explicitHourlyNanos,
      mode: explicitHourlyNanos != null ? 'fixed' : 'uncapped',
      watHour,
      remainingWatHours,
      baselineHourlyAllowanceNanos: explicitHourlyNanos,
      dailyUsedBeforeCurrentHourNanos: 0n,
      remainingDailyAtHourStartNanos: 0n,
    };
  }
  if (input.hourlyPacingUsdCents == null) {
    return {
      effectiveHourlyAllowanceNanos: null,
      mode: 'uncapped',
      watHour,
      remainingWatHours,
      baselineHourlyAllowanceNanos: null,
      dailyUsedBeforeCurrentHourNanos: 0n,
      remainingDailyAtHourStartNanos: 0n,
    };
  }

  if (input.dailyBudgetUsdCents <= 0 || input.hourlyPacingUsdCents <= 0) {
    return {
      effectiveHourlyAllowanceNanos: 0n,
      mode: 'fixed',
      watHour,
      remainingWatHours,
      baselineHourlyAllowanceNanos: explicitHourlyNanos ?? 0n,
      dailyUsedBeforeCurrentHourNanos: input.dailyUsedNanos > input.hourlyUsedNanos ? input.dailyUsedNanos - input.hourlyUsedNanos : 0n,
      remainingDailyAtHourStartNanos: 0n,
    };
  }

  const dailyBudgetNanos = BigInt(input.dailyBudgetUsdCents) * NANO_CENT;
  const remainingHours = BigInt(remainingWatHours);

  const dailyUsedBeforeCurrentHourNanos =
    input.dailyUsedNanos > input.hourlyUsedNanos ? input.dailyUsedNanos - input.hourlyUsedNanos : 0n;

  const remainingDailyAtHourStartNanos =
    dailyBudgetNanos > dailyUsedBeforeCurrentHourNanos
      ? dailyBudgetNanos - dailyUsedBeforeCurrentHourNanos
      : 0n;

  let redistributedNanos = remainingDailyAtHourStartNanos / remainingHours;

  const burstMultiplier = input.maxBurstMultiplier ?? 3n;
  const baselineHourlyNanos = dailyBudgetNanos / 24n;
  if (remainingHours > 1n && burstMultiplier > 0n) {
    const referenceHourlyNanos =
      explicitHourlyNanos != null && explicitHourlyNanos > baselineHourlyNanos
        ? explicitHourlyNanos
        : baselineHourlyNanos;
    const burstCapNanos = referenceHourlyNanos * burstMultiplier;
    if (redistributedNanos > burstCapNanos) {
      redistributedNanos = burstCapNanos;
    }
  }

  if (redistributedNanos > remainingDailyAtHourStartNanos) {
    redistributedNanos = remainingDailyAtHourStartNanos;
  }

  return {
    effectiveHourlyAllowanceNanos: redistributedNanos,
    mode: 'adaptive',
    watHour,
    remainingWatHours,
    baselineHourlyAllowanceNanos: explicitHourlyNanos ?? baselineHourlyNanos,
    dailyUsedBeforeCurrentHourNanos,
    remainingDailyAtHourStartNanos,
  };
}

/**
 * Computes the effective hourly spending allowance in USD nanos (`10^7` nanos = 1 cent).
 */
export function computeEffectiveHourlyAllowanceNanos(
  input: AdaptiveHourlyPacingInput,
): bigint | null {
  return computeAdaptiveHourlyPacingDetails(input).effectiveHourlyAllowanceNanos;
}
