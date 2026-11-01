import financial from "../../../../../shared/src/config/financial-constants.json";
export const SCALE = 1_000_000n;
export function houseProgramRequested(env = process.env) {
  return (
    financial.houseRewards.enabled === true &&
    env.ADS_CFIG_ACCRUAL_ENABLED === "true" &&
    env.ADS_CFIG_ACTIVATION_APPROVED === "true"
  );
}
export function canonicalHousePolicy() {
  return structuredClone(financial.houseRewards);
}
export type HousePolicy = ReturnType<typeof canonicalHousePolicy>;
export function policyLimits(p: HousePolicy) {
  for (const key of [
    "impressionsPerCfig",
    "clicksPerCfig",
    "dailyCapApprovedCfig",
    "monthlyCapPerPromoterCfig",
    "monthlyBudgetUsdCents",
    "maxOutstandingUsdCents",
    "proposedCfigPerFundedPoint",
    "finalizationHours",
    "pendingHoldHours",
    "maxCandidatesPerDay",
  ] as const)
    if (!Number.isSafeInteger(p[key]) || p[key] < 0 ||
      (p[key] === 0 && !['dailyCapApprovedCfig','monthlyCapPerPromoterCfig','monthlyBudgetUsdCents','maxOutstandingUsdCents'].includes(key)))
      throw new Error("Invalid House policy limits");
  if (
    p.qualifyingSupply !== "approved_only" ||
    p.dailyCapTestingCfig !== 0 ||
    p.finalizationHours !== 72 ||
    p.pendingHoldHours < 72 ||
    p.conversionEnabled !== false ||
    !p.policyVersion
  )
    throw new Error("Unsupported House policy");
  const perPoint = financial.rewardsValuation.centsPerPoint;
  if (!Number.isSafeInteger(perPoint) || perPoint <= 0)
    throw new Error("Invalid funded points valuation");
  if (SCALE % BigInt(p.impressionsPerCfig) || SCALE % BigInt(p.clicksPerCfig))
    throw new Error("Reward precision is not exact");
  return {
    view: SCALE / BigInt(p.impressionsPerCfig),
    click: SCALE / BigInt(p.clicksPerCfig),
    daily: BigInt(p.dailyCapApprovedCfig) * SCALE,
    monthly: BigInt(p.monthlyCapPerPromoterCfig) * SCALE,
    global:
      (BigInt(p.monthlyBudgetUsdCents) *
        BigInt(p.proposedCfigPerFundedPoint) *
        SCALE) /
      BigInt(perPoint),
    outstanding:
      (BigInt(p.maxOutstandingUsdCents) *
        BigInt(p.proposedCfigPerFundedPoint) *
        SCALE) /
      BigInt(perPoint),
  };
}
export function utcWindow(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("UTC date required");
  const start = new Date(day + "T00:00:00.000Z");
  if (!Number.isFinite(+start) || start.toISOString().slice(0, 10) !== day)
    throw new Error("Invalid UTC date");
  return {
    start,
    end: new Date(+start + 86400000),
    cutoff: new Date(+start + 86400000 + 72 * 3600000),
  };
}
export interface RewardCandidate {
  eventId: string;
  serveId: string;
  promoterId: string;
  servedAt: string;
  receivedAt: Date;
  validatedAt: Date | null;
  metric: string;
  eligible: boolean;
  exclusion?: string;
  policyId: string;
}
export interface Allocation {
  candidate: RewardCandidate;
  entitled: bigint;
  allocated: bigint;
  outcome: string;
  badgeEligible: boolean;
}
export function allocateDay(
  day: string,
  events: RewardCandidate[],
  p: HousePolicy,
  prior: {
    promoters: Map<string, bigint>;
    global: bigint;
    outstanding: bigint;
  },
  now: Date,
) {
  const w = utcWindow(day),
    limits = policyLimits(p);
  if (!Number.isFinite(+now) || now < w.cutoff)
    throw new Error("Day finalization window is still open");
  for (const amount of [
    prior.global,
    prior.outstanding,
    ...prior.promoters.values(),
  ])
    if (amount < 0n) throw new Error("Invalid cap reconciliation");
  const sorted = [...events].sort((a, b) => {
    for (const [x, y] of [
      [a.servedAt, b.servedAt],
      [a.serveId, b.serveId],
      [a.eventId, b.eventId],
    ]) {
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  });
  const daily = new Map<string, bigint>(),
    monthly = new Map(prior.promoters),
    seen = new Set<string>();
  let global = prior.global,
    outstanding = prior.outstanding;
  const allocations: Allocation[] = sorted.map((c) => {
    const no = (outcome: string): Allocation => ({
      candidate: c,
      entitled: 0n,
      allocated: 0n,
      outcome,
      badgeEligible: false,
    });
    if (
      !c.servedAt.startsWith(day + "T") ||
      !Number.isFinite(Date.parse(c.servedAt))
    )
      throw new Error("Candidate is outside immutable serve day");
    if (!Number.isFinite(+c.receivedAt) || c.receivedAt >= w.cutoff)
      return no("LATE_EXCLUDED");
    if (
      !c.eligible &&
      c.exclusion &&
      [
        "TESTING_EXCLUDED",
        "HISTORICAL_STATUS_UNKNOWN",
        "POLICY_INACTIVE",
        "WEBSITE_NOT_APPROVED",
      ].includes(c.exclusion)
    )
      return no(c.exclusion);
    if (
      !c.validatedAt ||
      !Number.isFinite(+c.validatedAt) ||
      c.validatedAt >= w.cutoff
    )
      return no("VALIDATION_INCOMPLETE");
    if (!c.eligible) return no(c.exclusion || "INELIGIBLE");
    if (!["click", "viewable_impression"].includes(c.metric))
      return no("UNSUPPORTED_METRIC");
    const key = c.serveId + ":" + c.metric;
    if (seen.has(key)) return no("DUPLICATE_SOURCE");
    seen.add(key);
    const entitled = c.metric === "click" ? limits.click : limits.view;
    const d = daily.get(c.promoterId) || 0n,
      m = monthly.get(c.promoterId) || 0n;
    const remaining = [
      limits.daily - d,
      limits.monthly - m,
      limits.global - global,
      limits.outstanding - outstanding,
    ];
    const allocated = remaining.reduce((a, b) => (b < a ? b : a), entitled);
    const value = allocated > 0n ? allocated : 0n;
    daily.set(c.promoterId, d + value);
    monthly.set(c.promoterId, m + value);
    global += value;
    outstanding += value;
    const reasons = [
      "DAILY_CAP",
      "MONTHLY_PROMOTER_CAP",
      "MONTHLY_GLOBAL_CAP",
      "OUTSTANDING_CAP",
    ];
    const reason = remaining.findIndex((v) => v <= value && value < entitled);
    return {
      candidate: c,
      entitled,
      allocated: value,
      outcome:
        value === entitled ? "ALLOCATED" : reasons[reason] || "PARTIAL_CAP",
      badgeEligible: true,
    };
  });
  return { allocations, global, outstanding, monthly };
}
