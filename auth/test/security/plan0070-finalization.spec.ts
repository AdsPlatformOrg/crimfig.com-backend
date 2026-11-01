import {
  allocateDay,
  canonicalHousePolicy,
  policyLimits,
  utcWindow,
  houseProgramRequested,
  RewardCandidate,
} from "../../../api/ads-api/src/modules/cfig/cfig-allocation";
const policy = canonicalHousePolicy(),
  day = "2026-11-01",
  closed = new Date("2026-11-05T00:00:00Z");
function event(
  id: string,
  patch: Partial<RewardCandidate> = {},
): RewardCandidate {
  return {
    eventId: id,
    serveId: "serve-" + id,
    promoterId: "promoter",
    servedAt: "2026-11-01T00:00:00.000000Z",
    receivedAt: new Date("2026-11-01T01:00Z"),
    validatedAt: new Date("2026-11-04T23:59:59Z"),
    metric: "viewable_impression",
    eligible: true,
    policyId: "policy",
    ...patch,
  };
}
const prior = () => ({
  promoters: new Map<string, bigint>(),
  global: 0n,
  outstanding: 0n,
});
describe("PLAN-0070 deterministic finalization — failure cases first", () => {
  it('a genuine zero budget stops monetary allocation while preserving qualified prestige progress',()=>{
    const result=allocateDay(day,[event('zero')],{...policy,monthlyBudgetUsdCents:0},prior(),closed);
    expect(result.global).toBe(0n);expect(result.allocations[0].allocated).toBe(0n);expect(result.allocations[0].badgeEligible).toBe(true);
    expect(()=>policyLimits({...policy,finalizationHours:96})).toThrow('Unsupported');
  });
  it("cannot enable production through environment flags alone", () => {
    expect(
      houseProgramRequested({
        ADS_CFIG_ACCRUAL_ENABLED: "true",
        ADS_CFIG_ACTIVATION_APPROVED: "true",
      }),
    ).toBe(false);
  });
  it("rejects an open day, invalid dates, negative reconciliation and nonexact reward precision", () => {
    expect(() =>
      allocateDay(day, [], policy, prior(), new Date("2026-11-04T23:59Z")),
    ).toThrow();
    expect(() => utcWindow("2026-02-30")).toThrow();
    expect(() =>
      allocateDay(day, [], policy, { ...prior(), outstanding: -1n }, closed),
    ).toThrow();
    expect(() => policyLimits({ ...policy, impressionsPerCfig: 3 })).toThrow();
  });
  it("TESTING and unknown historical status never consume reward or badge capacity", () => {
    const result = allocateDay(
      day,
      [
        event("testing", {
          eligible: false,
          exclusion: "TESTING_EXCLUDED",
          validatedAt: null,
        }),
        event("unknown", {
          eligible: false,
          exclusion: "HISTORICAL_STATUS_UNKNOWN",
          validatedAt: null,
        }),
      ],
      policy,
      prior(),
      closed,
    );
    expect(result.allocations.map((a) => a.outcome)).toEqual([
      "TESTING_EXCLUDED",
      "HISTORICAL_STATUS_UNKNOWN",
    ]);
    expect(result.global).toBe(0n);
    expect(result.allocations.every((a) => !a.badgeEligible)).toBe(true);
  });
  it("exclusive receipt and validation cutoff excludes late/unresolved events without next-day shifting", () => {
    const a = allocateDay(
      day,
      [
        event("late", { receivedAt: closed }),
        event("incomplete", { validatedAt: closed }),
        event("missing", { validatedAt: null }),
      ],
      policy,
      prior(),
      closed,
    ).allocations;
    expect(a.map((x) => x.outcome)).toEqual([
      "VALIDATION_INCOMPLETE",
      "LATE_EXCLUDED",
      "VALIDATION_INCOMPLETE",
    ]);
    expect(a.every((x) => x.allocated === 0n)).toBe(true);
  });
  it("invalid events and per-serve metric replays do not mint rewards; separate valid instances stay independent", () => {
    const events = [
      event("a"),
      event("b", { serveId: "serve-a" }),
      event("c", { eligible: false, exclusion: "INVALID_TRAFFIC" }),
      event("d"),
    ];
    const result = allocateDay(day, events, policy, prior(), closed);
    expect(result.global).toBe(400n);
    expect(result.allocations[1].outcome).toBe("DUPLICATE_SOURCE");
    expect(result.allocations[2].allocated).toBe(0n);
  });
  it("applies partial monthly/global/outstanding capacity without rounding and preserves badge qualification", () => {
    for (const state of [
      { ...prior(), promoters: new Map([["promoter", 99_999_999n]]) },
      { ...prior(), global: 499_999_999_999n },
      { ...prior(), outstanding: 999_999_999_999n },
    ]) {
      const result = allocateDay(
        day,
        [event("a"), event("b")],
        policy,
        state,
        closed,
      );
      expect(result.allocations.map((a) => a.allocated)).toEqual([1n, 0n]);
      expect(result.allocations.every((a) => a.badgeEligible)).toBe(true);
    }
  });
  it("retains exact 200/40000 fractional units and independent view/click streams for one serve", () => {
    expect(policyLimits(policy)).toMatchObject({
      view: 200n,
      click: 40000n,
      daily: 10000000n,
      monthly: 100000000n,
      global: 500000000000n,
      outstanding: 1000000000000n,
    });
    expect(
      allocateDay(
        day,
        [event("a"), event("b", { serveId: "serve-a", metric: "click" })],
        policy,
        prior(),
        closed,
      ).global,
    ).toBe(40200n);
  });
  it("is identical for every worker input permutation, including cross-promoter global contention", () => {
    const events = [
        event("c", { promoterId: "p2" }),
        event("b", { metric: "click" }),
        event("a"),
      ],
      state = { ...prior(), global: 499_999_999_700n };
    const amounts = (xs: RewardCandidate[]) =>
      allocateDay(day, xs, policy, state, closed).allocations.map((a) => [
        a.candidate.eventId,
        a.allocated.toString(),
      ]);
    expect(amounts(events)).toEqual(amounts([...events].reverse()));
    expect(amounts(events)).toEqual([
      ["a", "200"],
      ["b", "100"],
      ["c", "0"],
    ]);
  });
  it("uses original UTC serve day, submillisecond order and immutable UUID tie-breaks", () => {
    expect(utcWindow(day).cutoff.toISOString()).toBe(
      "2026-11-05T00:00:00.000Z",
    );
    const a = event("a", { servedAt: "2026-11-01T00:00:00.000002Z" }),
      b = event("b", { servedAt: "2026-11-01T00:00:00.000001Z" });
    expect(
      allocateDay(day, [a, b], policy, prior(), closed).allocations[0].candidate
        .eventId,
    ).toBe("b");
    expect(() =>
      allocateDay(
        day,
        [event("wrong", { servedAt: "2026-11-02T00:00:00Z" })],
        policy,
        prior(),
        closed,
      ),
    ).toThrow();
  });
  it("combines approved websites/streams under one daily cap while excluded TESTING never contributes", () => {
    const events = Array.from({ length: 251 }, (_, i) =>
      event(String(i).padStart(4, "0"), { metric: "click" }),
    );
    const result = allocateDay(
      day,
      [
        ...events,
        event("testing", { eligible: false, exclusion: "TESTING_EXCLUDED" }),
      ],
      policy,
      prior(),
      closed,
    );
    expect(result.global).toBe(10_000_000n);
    expect(result.allocations[250].allocated).toBe(0n);
    expect(result.allocations[250].badgeEligible).toBe(true);
  });
});
