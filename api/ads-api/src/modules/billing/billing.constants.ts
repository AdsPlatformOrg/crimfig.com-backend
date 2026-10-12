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

// ─── Exchange Rate Fallback ─────────────────────────────────────────────────
export const DEFAULT_USD_NGN_EXCHANGE_RATE = 1625.50;      // 1 USD = ₦1,625.50 fallback if feed offline

/**
 * Helper to calculate revenue distribution for a given gross spend in cents.
 */
export function calculateRevenueDistribution(grossSpendUsdCents: number) {
  const publisherEarningsCents = Math.round(grossSpendUsdCents * PUBLISHER_REVENUE_SHARE_RATIO);
  const crimfigBaseRevenueCents = Math.round(grossSpendUsdCents * CRIMFIG_BASE_REVENUE_RATIO);
  const commissionPoolCents = Math.round(grossSpendUsdCents * MARKETING_COMMISSION_POOL_RATIO);

  return {
    grossSpendUsdCents,
    publisherEarningsCents,
    crimfigBaseRevenueCents,
    commissionPoolCents,
    totalPlatformRetainedCents: crimfigBaseRevenueCents + commissionPoolCents,
  };
}
