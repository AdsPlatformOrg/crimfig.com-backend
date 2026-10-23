/**
 * CrimFig Ads & Ecosystem Billing Constants
 *
 * Single source of truth for revenue sharing, platform retention, and commission allocations.
 * STRICT DIRECTIVE: Configured as exported constants in application code, NEVER in .env.
 */

// ─── Primary 55/30/15 Revenue Distribution ──────────────────────────────────
export const PUBLISHER_REVENUE_SHARE_RATIO = 0.55;         // 55% fixed share to verified publishers/creators
export const CRIMFIG_BASE_REVENUE_RATIO = 0.30;             // 30% guaranteed platform revenue
export const MARKETING_COMMISSION_POOL_RATIO = 0.15;        // 15% referral & marketing commission pool

// ─── Commission Allocation Caps & Defaults ──────────────────────────────────
export const MAX_EXTERNAL_REFERRAL_COMMISSION_RATIO = 0.15; // Max 15% to external referrer
export const DEFAULT_EXTERNAL_REFERRAL_COMMISSION_RATIO = 0.10; // Default 10% ($10 per $100 ad spend)
export const DEFAULT_INTERNAL_MARKETING_COMMISSION_RATIO = 0.05; // Default 5% ($5 per $100 ad spend)

// ─── Performance Bonus Protection ───────────────────────────────────────────
// Premium publisher bonuses are budgeted separately to prevent diluting the referral pool
export const PERFORMANCE_BONUS_POOL_RATIO = 0.00;          // Separately budgeted, 0% dilution of referral pool

// NOTE: No hardcoded USD/NGN fallback rate exists by design. FX must come only from the fresh,
// persisted, validated Billing quote (PLAN-0009 FX policy); if unavailable, fail closed.

/**
 * Helper to calculate revenue distribution for a given gross spend in cents.
 *
 * Integer-exact: publisher and commission-pool shares are floored and CrimFig base revenue is
 * the remainder, so publisher + crimfigBase + commissionPool === grossSpendUsdCents always.
 * Independent rounding of each share could create or destroy cents; flooring the publisher
 * side never over-pays promoters. Gross must be a non-negative safe integer.
 */
export function calculateRevenueDistribution(grossSpendUsdCents: number) {
  if (!Number.isSafeInteger(grossSpendUsdCents) || grossSpendUsdCents < 0) {
    throw new RangeError('grossSpendUsdCents must be a non-negative safe integer');
  }
  // Integer percent math (ratios are whole percents) avoids binary-float drift such as 0.55*n.
  const publisherPct = Math.round(PUBLISHER_REVENUE_SHARE_RATIO * 100);
  const commissionPct = Math.round(MARKETING_COMMISSION_POOL_RATIO * 100);
  const publisherEarningsCents = Number(BigInt(grossSpendUsdCents) * BigInt(publisherPct) / 100n);
  const commissionPoolCents = Number(BigInt(grossSpendUsdCents) * BigInt(commissionPct) / 100n);
  const crimfigBaseRevenueCents = grossSpendUsdCents - publisherEarningsCents - commissionPoolCents;

  return {
    grossSpendUsdCents,
    publisherEarningsCents,
    crimfigBaseRevenueCents,
    commissionPoolCents,
    totalPlatformRetainedCents: crimfigBaseRevenueCents + commissionPoolCents,
  };
}
