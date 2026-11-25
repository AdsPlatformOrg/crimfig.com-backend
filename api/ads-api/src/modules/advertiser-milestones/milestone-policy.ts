import type { MilestoneEvidence } from './milestone-evidence';

export const recognitionPolicyVersion = 'advertiser-rewards-v3';

export interface MilestoneDefinition {
  tier: string;
  title: string;
  cumulativeSpendTargetCents: number;
  bonusCreditCents: number;
  maxPromoterEarningsCents: number;
  requiresTenureMonths: number;
  requiresCleanCompliance: boolean;
  isPrestige: boolean;
  requirement: string;
}

export const milestoneDefinitions: MilestoneDefinition[] = [
  {
    tier: 'A1_FIRST_CAMPAIGN',
    title: 'A1 — First Advertiser',
    cumulativeSpendTargetCents: 500,
    bonusCreditCents: 500,
    maxPromoterEarningsCents: 275,
    requiresTenureMonths: 0,
    requiresCleanCompliance: false,
    isPrestige: false,
    requirement: 'Reach $5.00 in post-launch cumulative cleared cash advertising spend across eligible approved campaigns.',
  },
  {
    tier: 'A2_CONSISTENT',
    title: 'A2 — Consistent Advertiser',
    cumulativeSpendTargetCents: 10000,
    bonusCreditCents: 1500,
    maxPromoterEarningsCents: 825,
    requiresTenureMonths: 0,
    requiresCleanCompliance: false,
    isPrestige: false,
    requirement: 'Reach $100.00 in post-launch cumulative cleared cash advertising spend across eligible approved campaigns.',
  },
  {
    tier: 'A3_GROWTH',
    title: 'A3 — Growth Advertiser',
    cumulativeSpendTargetCents: 50000,
    bonusCreditCents: 5000,
    maxPromoterEarningsCents: 2750,
    requiresTenureMonths: 0,
    requiresCleanCompliance: false,
    isPrestige: false,
    requirement: 'Reach $500.00 in post-launch cumulative cleared cash advertising spend across eligible approved campaigns.',
  },
  {
    tier: 'A4_TRUSTED',
    title: 'A4 — Trusted Advertiser',
    cumulativeSpendTargetCents: 250000,
    bonusCreditCents: 15000,
    maxPromoterEarningsCents: 8250,
    requiresTenureMonths: 12,
    requiresCleanCompliance: true,
    isPrestige: false,
    requirement: 'Reach $2,500.00 in post-launch cumulative cleared cash spend with at least 12 calendar months account tenure and a clean compliance record.',
  },
  {
    tier: 'PRESTIGE_100',
    title: 'Prestige 10K',
    cumulativeSpendTargetCents: 1000000,
    bonusCreditCents: 10000,
    maxPromoterEarningsCents: 5500,
    requiresTenureMonths: 0,
    requiresCleanCompliance: true,
    isPrestige: true,
    requirement: 'Reach $10,000.00 in post-launch cumulative cleared cash spend with a clean compliance record. Permanent badge, once per lifetime.',
  },
  {
    tier: 'PRESTIGE_1000',
    title: 'Prestige 100K',
    cumulativeSpendTargetCents: 10000000,
    bonusCreditCents: 50000,
    maxPromoterEarningsCents: 27500,
    requiresTenureMonths: 0,
    requiresCleanCompliance: true,
    isPrestige: true,
    requirement: 'Reach $100,000.00 in post-launch cumulative cleared cash spend with a clean compliance record. Permanent badge, once per lifetime.',
  },
  {
    tier: 'PRESTIGE_10000',
    title: 'Prestige 1M',
    cumulativeSpendTargetCents: 100000000,
    bonusCreditCents: 250000,
    maxPromoterEarningsCents: 137500,
    requiresTenureMonths: 0,
    requiresCleanCompliance: true,
    isPrestige: true,
    requirement: 'Reach $1,000,000.00 in post-launch cumulative cleared cash spend with a clean compliance record. Permanent badge, once per lifetime.',
  },
];

export const BONUS_CREDIT_LIFETIME_MAX_CENTS = milestoneDefinitions.reduce(
  (sum, d) => sum + d.bonusCreditCents,
  0,
); // 332,000 cents ($3,320.00)

export const BONUS_PROMO_BASE_CPM_CENTS = 50; // $0.50 base CPM initially
export const BONUS_PROMO_IMPRESSION_FACE_MICROUSD = 500; // $0.0005 per viewable impression
export const BONUS_PROMO_PROMOTER_SHARE_BPS = 5500; // 55% promoter share = 275 microusd/impression

export function recognitionDecisions(evidence: MilestoneEvidence) {
  const unique = new Map(evidence.campaigns.map(campaign => [campaign.id, campaign]));
  const eligible = [...unique.values()].filter(
    campaign =>
      evidence.fundingVerified &&
      (campaign.qualifying ?? campaign.completed) &&
      campaign.eligible &&
      Number.isSafeInteger(campaign.clearedSpendCents) &&
      campaign.clearedSpendCents! > 0,
  );
  const cumulativeSpendCents = eligible.reduce(
    (sum, campaign) => sum + campaign.clearedSpendCents!,
    0,
  );
  const tenureMonths = evidence.tenureMonths ?? 0;
  // Unknown/missing compliance must never be called clean when a tier requires clean compliance
  const complianceClean = evidence.complianceClean === true;
  const underInvestigation = evidence.underInvestigation === true;

  return milestoneDefinitions.map(definition => {
    const spendMet = cumulativeSpendCents >= definition.cumulativeSpendTargetCents;
    const tenureMet = tenureMonths >= definition.requiresTenureMonths;
    // JED Section 2: Pending investigation holds ONLY new A4 & Prestige (requiresCleanCompliance) claims;
    // A1-A3 proceed when ordinary spend & verified funding requirements pass.
    const heldByInvestigation = definition.requiresCleanCompliance && underInvestigation;
    const complianceMet = !definition.requiresCleanCompliance || (complianceClean && !heldByInvestigation);
    return {
      ...definition,
      qualified: Boolean(evidence.fundingVerified && spendMet && tenureMet && complianceMet),
      heldByInvestigation: Boolean(evidence.fundingVerified && spendMet && tenureMet && complianceClean && heldByInvestigation),
      cumulativeSpendCents,
      tenureMet,
      complianceMet,
    };
  });
}
