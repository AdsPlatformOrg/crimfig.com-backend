import { NANO_CENT } from '@crimfig/shared';
import { computeEffectiveHourlyAllowanceNanos, getWatHour } from '../../../api/billing-api/src/modules/ecosystem/adaptive-pacing';

describe('PLAN-0113 Adaptive Daily Budget Pacing & Unused Hourly Redistribution', () => {
  it('redistributes unused capacity from 6 quiet WAT hours ($5.00 / 18 = $0.277777777/hr)', () => {
    // 06:00 WAT = 05:00 UTC -> remainingHours = 18
    const sixAmWat = new Date('2026-11-14T05:00:00.000Z');
    expect(getWatHour(sixAmWat)).toBe(6);

    const allowance = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500, // $5.00 = 5_000_000_000 nanos
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 0n,
      hourlyUsedNanos: 0n,
      now: sixAmWat,
    });

    // 5_000_000_000n / 18n = 277_777_777n ($0.277777777)
    expect(allowance).toBe(5_000_000_000n / 18n);
    expect(allowance! > 21n * NANO_CENT).toBe(true);
  });

  it('enforces burst protection so 23 quiet hours cannot dump the entire daily budget into 1 hour if >1 hour remains', () => {
    // 22:00 WAT = 21:00 UTC -> remainingHours = 2
    const tenPmWat = new Date('2026-11-14T21:00:00.000Z');
    expect(getWatHour(tenPmWat)).toBe(22);

    const allowance = computeEffectiveHourlyAllowanceNanos({
      dailyBudgetUsdCents: 500,
      hourlyPacingUsdCents: 21,
      dailyUsedNanos: 0n,
      hourlyUsedNanos: 0n,
      now: tenPmWat,
      maxBurstMultiplier: 3n,
    });

    // Uncapped would be 5_000_000_000n / 2n = 2_500_000_000n ($2.50),
    // but burst cap = 3 * 210_000_000n = 630_000_000n ($0.63).
    expect(allowance).toBe(630_000_000n);
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

    // 5_000_000_000n / 24n = 208_333_333n (~$0.2083)
    expect(allowance).toBe(5_000_000_000n / 24n);
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
});

