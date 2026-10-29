import { AuctionEngineService } from "../../../api/ads-api/src/modules/delivery/auction-engine.service";

describe("PLAN-0039 minute scheduling", () => {
  it("excludes a custom minute schedule before its inclusive start", () => {
    const candidate: any = {
      campaignId: "c",
      creativeId: "x",
      headline: "Test",
      destinationUrl: "https://example.com",
      pricingVersion: 2,
      pricingModel: "cpm",
      costPerImpressionUsdCents: 50,
      costPerClickUsdCents: 10,
      remainingBudgetUsdCents: 500,
      format: "card",
      schedule: {
        version: 1,
        mode: "custom",
        timezone: "Africa/Lagos",
        ranges: [{ startMinute: 570, endMinute: 1020 }],
      },
    };
    expect(
      new AuctionEngineService().resolveAuction([candidate], {
        slotHandle: "CARD",
        requestedAt: new Date("2026-10-29T08:29:59Z"),
      }),
    ).toBeNull();
  });
});
import {
  validateSchedule,
  legacySchedule,
  resolvedSchedule,
  scheduleMatches,
  allDay,
  inherited,
} from "../../../api/ads-api/src/modules/campaigns/daily-schedule";

describe("schedule contract", () => {
  const schedule = (a: number, b: number) =>
    validateSchedule({
      mode: "custom",
      timezone: "Africa/Lagos",
      ranges: [{ startMinute: a, endMinute: b }],
    });
  it.each([
    ["08:29:59", false],
    ["08:30:00", true],
    ["15:59:59", true],
    ["16:00:00", false],
  ])("honors WAT minute boundaries %s", (time, allowed) =>
    expect(
      scheduleMatches(schedule(570, 1020), new Date(`2026-10-29T${time}Z`)),
    ).toBe(allowed),
  );
  it("matches overnight without filling daytime", () => {
    for (const [time, yes] of [
      ["21:00", true],
      ["00:59", true],
      ["01:00", false],
      ["20:59", false],
    ] as const)
      expect(
        scheduleMatches(
          schedule(1320, 120),
          new Date(`2026-10-29T${time}:00Z`),
        ),
      ).toBe(yes);
  });
  it("rejects overlap across midnight, equal, empty, malformed and too many ranges", () => {
    for (const ranges of [
      [],
      [{ startMinute: 0, endMinute: 0 }],
      [
        { startMinute: 1320, endMinute: 120 },
        { startMinute: 60, endMinute: 180 },
      ],
      [{ startMinute: 1440, endMinute: 20 }],
      Array.from({ length: 11 }, (_, i) => ({
        startMinute: i * 2,
        endMinute: i * 2 + 1,
      })),
    ])
      expect(() =>
        validateSchedule({ mode: "custom", timezone: "Africa/Lagos", ranges }),
      ).toThrow();
  });
  it("allows adjacency and resolves explicit all day independently of inheritance", () => {
    expect(() =>
      validateSchedule({
        mode: "custom",
        timezone: "Africa/Lagos",
        ranges: [
          { startMinute: 0, endMinute: 1 },
          { startMinute: 1, endMinute: 2 },
        ],
      }),
    ).not.toThrow();
    expect(resolvedSchedule(schedule(570, 1020), allDay())).toEqual(allDay());
    expect(resolvedSchedule(schedule(570, 1020), inherited())).toEqual(
      schedule(570, 1020),
    );
  });
  it("preserves each legacy hour across midnight and stored empty-stack override", () => {
    for (const hours of [
      [0, 1, 22, 23],
      Array.from({ length: 24 }, (_, i) => i),
      [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23],
    ]) {
      const s = legacySchedule(hours);
      for (let m = 0; m < 1440; m++)
        expect(
          scheduleMatches(s, new Date(Date.UTC(2026, 9, 29, 0, m - 60))),
        ).toBe(hours.includes(Math.floor(m / 60)));
    }
    expect(legacySchedule(null, true)).toEqual(inherited());
    expect(legacySchedule("[]", true)).toEqual(allDay());
  });
  it("fails closed rather than accepting invalid persisted modes", () =>
    expect(() => resolvedSchedule({ mode: "broken" }, null)).toThrow());
});
