import {
  canonicalPaidRewardLoops,
  paidRewardMetric,
  earnedLoopDelta,
  AuditedPricingEvent,
} from "../../../shared/src/rewards-performance-policy";
const at = new Date("2026-11-01T00:00:00Z");
const event: AuditedPricingEvent = {
  inventoryClass: "paid",
  deliveryMode: "normal",
  pricingModel: "cpc",
  type: "click",
  eventId: "event",
  serveId: "serve",
  promoterId: "promoter",
  claimEventId: "event",
  reservationServeId: "serve",
  reservationPromoterId: "promoter",
  simulated: false,
  isValid: true,
  auditOutcome: "eligible",
  evidenceIntegrity: true,
  settledAt: at,
};
describe("PLAN-0070 frozen paid economics — no issuance", () => {
  it.each([
    { type: "viewable_impression" },
    { pricingModel: "cpm", type: "click" },
    { inventoryClass: "house" },
    { deliveryMode: "shadow" },
    { simulated: true },
    { isValid: false },
    { auditOutcome: "quarantined" },
    { evidenceIntegrity: false },
    { settledAt: null },
    { settledAt: new Date("2099-01-01") },
    { claimEventId: "other" },
    { reservationServeId: "other" },
    { reservationPromoterId: "other" },
  ])(
    "rejects wrong pricing event or unvalidated/unsettled binding %j",
    (patch) => {
      expect(paidRewardMetric({ ...event, ...patch }, at)).toBeNull();
    },
  );
  it("rejects decreasing or negative progress rather than minting compensating points", () => {
    expect(() => earnedLoopDelta("cpm", 0n, -1n)).toThrow();
    expect(() => earnedLoopDelta("cpc", 100n, 99n)).toThrow();
  });
  it("retains canonical 20,000-view and 100-click rates from the single JSON source", () => {
    expect(canonicalPaidRewardLoops()).toMatchObject({
      cpm: { interval: 20000, points: 10 },
      cpc: { interval: 100, points: 10 },
      pointsPerUsd: 100,
    });
    expect(earnedLoopDelta("cpm", 0n, 1000n)).toMatchObject({
      loops: "0",
      potentialPoints: "0",
      issuedPoints: "0",
    });
    expect(earnedLoopDelta("cpm", 0n, 20000n)).toMatchObject({
      loops: "1",
      potentialPoints: "10",
      issuedPoints: "0",
    });
  });
  it("allows audited settled CPC click without requiring a preceding view and keeps CPM separate", () => {
    expect(paidRewardMetric(event, at)).toBe("click");
    expect(
      paidRewardMetric(
        { ...event, pricingModel: "cpm", type: "viewable_impression" },
        at,
      ),
    ).toBe("viewable_impression");
    expect(earnedLoopDelta("cpc", 99n, 101n)).toEqual({
      loops: "1",
      potentialPoints: "10",
      residualEvents: "1",
      issuedPoints: "0",
    });
  });
});
