import constants from "./config/financial-constants.json";
/** Frozen canonical economics. This contract never issues points or moves funds. */
export function canonicalPaidRewardLoops() {
  const click = constants.categoryBPerpetualLoops.find(
    (v) => v.metric === "verified_clicks",
  );
  const view = constants.categoryBPerpetualLoops.find(
    (v) => v.metric === "viewable_impressions",
  );
  if (
    !click ||
    !view ||
    !Number.isSafeInteger(click.interval) ||
    !Number.isSafeInteger(view.interval) ||
    click.interval <= 0 ||
    view.interval <= 0
  )
    throw new Error("Canonical reward loops unavailable");
  return {
    version: constants.version,
    cpc: {
      metric: "click" as const,
      interval: click.interval,
      points: click.pointsAwarded,
    },
    cpm: {
      metric: "viewable_impression" as const,
      interval: view.interval,
      points: view.pointsAwarded,
    },
    pointsPerUsd: constants.rewardsValuation.pointsPerUsd,
  };
}
export interface AuditedPricingEvent {
  inventoryClass: string;
  deliveryMode: string;
  pricingModel: string;
  type: string;
  eventId: string;
  serveId: string;
  promoterId: string;
  claimEventId: string;
  reservationServeId: string;
  reservationPromoterId: string;
  simulated: boolean;
  isValid: boolean;
  auditOutcome: string;
  evidenceIntegrity: boolean;
  settledAt: Date | null;
}
/** Internal classification only, after signed evidence/settlement reads. Never
 * accept these booleans as a public request. Funding/caps/replay remain separate.
 */
export function paidRewardMetric(
  event: AuditedPricingEvent,
  now = new Date(),
): "click" | "viewable_impression" | null {
  if (
    event.inventoryClass !== "paid" ||
    event.deliveryMode === "shadow" ||
    event.simulated ||
    !event.isValid ||
    event.auditOutcome !== "eligible" ||
    !event.evidenceIntegrity ||
    !event.settledAt ||
    !Number.isFinite(event.settledAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    event.settledAt > now ||
    !event.eventId ||
    !event.serveId ||
    !event.promoterId ||
    event.claimEventId !== event.eventId ||
    event.reservationServeId !== event.serveId ||
    event.reservationPromoterId !== event.promoterId
  )
    return null;
  if (event.pricingModel === "cpc" && event.type === "click") return "click";
  if (event.pricingModel === "cpm" && event.type === "viewable_impression")
    return "viewable_impression";
  return null;
}
export function earnedLoopDelta(
  model: "cpc" | "cpm",
  prior: bigint,
  current: bigint,
) {
  if (prior < 0n || current < prior)
    throw new Error("Monotonic deduplicated event totals required");
  const policy = canonicalPaidRewardLoops()[model],
    interval = BigInt(policy.interval);
  const loops = current / interval - prior / interval;
  return {
    loops: loops.toString(),
    potentialPoints: (loops * BigInt(policy.points)).toString(),
    residualEvents: (current % interval).toString(),
    issuedPoints: "0",
  };
}

/** Prestige only; preserve impression identities and never duplicate monetary bonuses. */
export function paidBadgeAwards(model: "cpc" | "cpm", total: bigint) {
  const tiers = constants.categoryAMilestones.filter(
    (m) => m.metric === "viewable_impressions",
  );
  return tiers.flatMap((tier, i) => {
    const threshold =
      model === "cpc"
        ? constants.fundedRewards.paidClickThresholds[i]
        : tier.threshold;
    return threshold !== undefined && total >= BigInt(threshold)
      ? [
          {
            key: model === "cpc" ? "paid_click_tier_" + tier.tier : tier.key,
            title:
              tier.badgeTitle +
              " - " +
              (model === "cpc" ? "Click" : "Impression") +
              " Edition",
            icon: model === "cpc" ? "mouse-pointer" : "eye",
            tier: tier.tier,
            pointsAwarded: 0,
          },
        ]
      : [];
  });
}
