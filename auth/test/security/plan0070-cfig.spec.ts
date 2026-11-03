import { CfigService } from "../../../api/ads-api/src/modules/cfig/cfig.service";
import {
  parsePolicy,
  transition,
  units,
  CFIG_HOLD_MS,
} from "../../../api/ads-api/src/modules/cfig/cfig-policy";
import * as allocation from "../../../api/ads-api/src/modules/cfig/cfig-allocation";
import {
  adDigest,
  evidenceSignature,
} from "../../../shared/src/ad-authority-policy";
import {
  AdminCfigController,
  PromoterCfigController,
} from "../../../api/ads-api/src/modules/cfig/cfig.controller";
import { ADS_ROLES_KEY } from "../../../api/ads-api/src/modules/security/ads-staff-grants";
import { PgDialect } from "drizzle-orm/pg-core";
const id = "00000000-0000-4000-8000-000000000001",
  actor = "00000000-0000-4000-8000-000000000002";
const config = allocation.canonicalHousePolicy(),
  terms = {
    version: config.policyVersion,
    termsVersion: config.policyVersion,
    effectiveFrom: "2026-11-01T00:00:00.000Z",
    houseRewards: config,
  };
describe("PLAN-0070 safeguards and canonical policy", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(["0", "-1", "1.2", "1e6", "001", 123])(
    "rejects non-integer/zero positive unit %s",
    (v) => expect(() => units(v)).toThrow(),
  );
  it("rejects legacy TESTING policies, missing snapshots and mismatched versions", () => {
    for (const p of [
      {},
      {
        ...terms,
        houseRewards: { ...config, qualifyingSupply: "verified_testing" },
      },
      { ...terms, version: "different" },
      { ...terms, effectiveFrom: "2026-11-01T12:00:00Z" },
    ])
      expect(() => parsePolicy(p)).toThrow();
  });
  it("early, same-reviewer and invalid clock clearance never creates availability", () => {
    const at = new Date("2026-11-01");
    for (const [now, independent] of [
      [new Date(+at + CFIG_HOLD_MS - 1), true],
      [new Date(+at + CFIG_HOLD_MS), false],
      [new Date(NaN), true],
    ] as const)
      expect(() =>
        transition("clear", 100n, 0n, at, now, independent),
      ).toThrow();
    expect(() => transition("invalidate", 0n, 0n, at, at, true)).toThrow();
  });
  it("disabled earning and conversion never write reward or funded assets", async () => {
    const queries: string[] = [];
    const tx = {
      execute: jest.fn(async (q: any) => {
        queries.push(new PgDialect().sqlToQuery(q).sql);
        return { rows: [] };
      }),
    };
    const s = new CfigService({ transaction: async (fn: any) => fn(tx) });
    await expect(
      s.decide(actor, id, {
        requestId: id,
        reason: "Audited source",
        action: "accrue",
      }),
    ).rejects.toThrow("disabled");
    expect(() => s.conversion()).toThrow("disabled");
    expect(queries.some((s) => s.startsWith("INSERT"))).toBe(false);
  });
  it("financial grants guard program administration; owner reads resolve authenticated identity", async () => {
    expect(Reflect.getMetadata(ADS_ROLES_KEY, AdminCfigController)).toEqual([
      "super_admin",
      "ads_finance",
    ]);
    const s: any = {
      owner: jest.fn(async () => id),
      balances: jest.fn(async () => ({})),
    };
    await new PromoterCfigController(s).balance({ user: { sub: actor } });
    expect(s.owner).toHaveBeenCalledWith(actor);
    expect(s.balances).toHaveBeenCalledWith(id);
  });
  it("policy proposal retries cannot create a second version and proposers cannot approve themselves", async () => {
    const responses = [[], [], [], [], [{ id: "existing" }]];
    const tx = {
      execute: jest.fn(async () => ({ rows: responses.shift() ?? [] })),
    };
    const service = new CfigService({ transaction: async (fn: any) => fn(tx) });
    await expect(
      service.propose(actor, {
        requestId: id,
        reason: "Policy review",
        terms: { ...terms, effectiveFrom: "2099-01-01T00:00:00Z" },
      }),
    ).rejects.toThrow("version already exists");
    expect(tx.execute).toHaveBeenCalledTimes(5);
    const self = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ created_by: actor }] }),
    };
    await expect(
      new CfigService({ transaction: async (fn: any) => fn(self) }).approve(
        actor,
        id,
        { requestId: id, reason: "Approval review" },
      ),
    ).rejects.toThrow("Independent");
  });
  it("a click cannot be marked eligible without explicit self-click/IVT audit; it creates no grant", async () => {
    jest.spyOn(allocation, "houseProgramRequested").mockReturnValue(true);
    const commands: any[] = [];
    const tx = {
      execute: jest.fn(async (q: any) => {
        commands.push(new PgDialect().sqlToQuery(q).sql);
        return { rows: [] };
      }),
    };
    const service = new CfigService({ transaction: async (fn: any) => fn(tx) });
    (service as any).proof = jest.fn(async () => ({
      event: { type: "click" },
      serve: {},
      supply: { user_id: "someone-else" },
      policy: { id: "policy" },
    }));
    await expect(
      service.decide(actor, id, {
        requestId: id,
        reason: "Click review",
        action: "accrue",
      }),
    ).rejects.toThrow("self-click");
    expect(commands.some((q) => q.startsWith("INSERT"))).toBe(false);
  });
  it("parses canonical terms and applies exact independent clearance/compensation", () => {
    expect(parsePolicy(terms).houseRewards.impressionsPerCfig).toBe(5000);
    const at = new Date("2026-11-01");
    expect(
      transition("clear", 200n, 0n, at, new Date(+at + CFIG_HOLD_MS), true),
    ).toEqual({ pending: -200n, available: 200n, invalid: 0n });
    expect(transition("invalidate", 0n, 200n, at, at, true)).toEqual({
      pending: 0n,
      available: -200n,
      invalid: 200n,
    });
  });
  it("House badge awards use separate keys and deterministic qualification dates without funded points", async () => {
    const commands: any[] = [];
    const tx = {
      execute: jest.fn(async (q: any) => {
        const parsed = new PgDialect().sqlToQuery(q);
        commands.push(parsed);
        return {
          rows: parsed.sql.startsWith("SELECT")
            ? [
                {
                  user_id: actor,
                  metric: "viewable_impression",
                  progress: "100",
                },
                { user_id: actor, metric: "click", progress: "10" },
              ]
            : [],
        };
      }),
    };
    const cutoff = new Date("2026-11-05T00:00Z");
    await (new CfigService({}) as any).awardHouseBadges(tx, config, cutoff);
    const inserts = commands.filter((c) => c.sql.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
    expect(
      inserts.every(
        (c) =>
          c.sql.includes("rewards_badges") && !c.sql.includes("rewards_points"),
      ),
    ).toBe(true);
    expect(inserts[0].params).toEqual(
      expect.arrayContaining(["house_impression_100", cutoff]),
    );
    expect(inserts[1].params).toEqual(
      expect.arrayContaining(["house_click_10"]),
    );
  });
  it("preserves zero virtual balances and never claims backing", async () => {
    const s = new CfigService({
      execute: async () => ({
        rows: [{ pending: "0", available: "0", invalid: "0", converted: "0" }],
      }),
    });
    expect(await s.balances(id)).toMatchObject({
      balances: { pending: "0", available: "0", invalid: "0", converted: "0" },
      earningEnabled: false,
      backedValue: null,
    });
  });
});
describe("PLAN-0070 finalizer transaction contract", () => {
  const previousKey = process.env.ADS_EVIDENCE_HASH_SECRET,
    previousId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
  beforeEach(() => {
    process.env.ADS_EVIDENCE_HASH_SECRET =
      "unit-only-reward-evidence-key-at-least-32-bytes";
    process.env.ADS_EVIDENCE_HASH_KEY_ID = "test";
    jest.spyOn(allocation, "houseProgramRequested").mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousKey === undefined) delete process.env.ADS_EVIDENCE_HASH_SECRET;
    else process.env.ADS_EVIDENCE_HASH_SECRET = previousKey;
    if (previousId === undefined) delete process.env.ADS_EVIDENCE_HASH_KEY_ID;
    else process.env.ADS_EVIDENCE_HASH_KEY_ID = previousId;
  });
  function fixture(options: any = {}) {
    const event: any = {
      id,
      serve_id: "serve",
      promoter_id: "promoter",
      type: "viewable_impression",
      created_at: new Date("2026-11-01T02:00Z"),
    };
    const context = {
      websitePolicy: "approved",
      ownershipStatus: "verified",
      programAuthorized: true,
      policyId: "policy",
      policyDigest: adDigest(terms),
    };
    const serve = {
      id: "serve",
      served_at: new Date("2026-11-01T01:00Z"),
      request_id: "request",
      promoter_id: "promoter",
      website_id: "site",
      slot_id: "slot",
      inventory_class: "house",
      delivery_mode: "normal",
      billing_price_nanos: "0",
      content_snapshot: { houseRewardContext: context },
    };
    const observation = {
      id: "serve",
      servedAt: serve.served_at.toISOString(),
      requestId: "request",
      promoterId: "promoter",
      websiteId: "site",
      slotId: "slot",
      inventoryClass: "house",
      deliveryMode: "normal",
      billingPrice: "0",
      contentSnapshot: serve.content_snapshot,
    };
    const review: any = {
      id: "review",
      eventId: id,
      actor: "reviewer",
      outcome: "eligible",
      reason: "Checked evidence",
      validatedAt: "2026-11-04T00:00:00.000Z",
      servedAt: serve.served_at.toISOString(),
      eventDigest: adDigest(event),
      serveDigest: adDigest(observation),
      policyId: "policy",
    };
    const source = {
      ...event,
      served_at: serve.served_at,
      serve_record: serve,
      original_serve_id: "serve",
      content_snapshot: serve.content_snapshot,
      serve_promoter_id: "promoter",
      ordered_serve_time: "2026-11-01T01:00:00.000000Z",
      review_id: "review",
      review_outcome: "eligible",
      review_actor: "reviewer",
      review_payload: review,
      review_key: "test",
      review_hash: evidenceSignature({ ...review, keyId: "test" }),
      validated_at: new Date(review.validatedAt),
    };
    if (options.fraud) {
      const signed = {
        id: "fraud",
        eventId: id,
        outcome: "invalid",
        keyId: "test",
      };
      (source as any).final_assessment = {
        id: "fraud",
        event_id: id,
        outcome: "invalid",
        key_id: "test",
        record_hash: evidenceSignature(signed),
      };
    }
    if (options.tamper) source.review_payload = { ...review, actor: "forged" };
    const commands: any[] = [],
      committed: any[] = [];
    const tx = {
      execute: jest.fn(async (q: any) => {
        const c = new PgDialect().sqlToQuery(q);
        commands.push(c);
        if (
          options.failInsert &&
          c.sql.startsWith("INSERT INTO cfig_allocations")
        )
          throw new Error("write failed");
        if (c.sql.includes("FROM cfig_finalizations WHERE request_id"))
          return { rows: options.retry ? [options.retry] : [] };
        if (c.sql.includes("FROM cfig_finalizations WHERE day="))
          return { rows: options.closed ? [{}] : [] };
        if (c.sql.includes("clock_timestamp() AS now"))
          return {
            rows: [{ now: new Date(options.now || "2026-11-05T00:00Z") }],
          };
        if (c.sql.includes("min((terms"))
          return { rows: [{ starts: new Date("2026-11-01T00:00Z") }] };
        if (c.sql.includes("FROM cfig_policies WHERE approved_at"))
          return {
            rows: [
              { id: "policy", terms, approved_at: new Date("2026-10-31") },
            ],
          };
        if (c.sql.includes("AS units")) return { rows: [{ units: "0" }] };
        if (c.sql.includes("to_char(v.served_at")) return { rows: [source] };
        return { rows: [] };
      }),
    };
    const db = {
      transaction: async (fn: any) => {
        const result = await fn(tx);
        committed.push(...commands.filter((c) => c.sql.startsWith("INSERT")));
        return result;
      },
    };
    return { service: new CfigService(db), commands, committed, source };
  }
  const input = { requestId: id, reason: "Close reviewed day" };
  it("rejects open day, skipped day and modified request identities without writes", async () => {
    for (const opts of [
      { now: "2026-11-04T00:00Z" },
      { retry: { fingerprint: "other" } },
    ]) {
      const h = fixture(opts);
      await expect(
        h.service.finalize(actor, "2026-11-01", input),
      ).rejects.toThrow();
      expect(h.committed).toHaveLength(0);
    }
    const h = fixture({ now: "2026-11-06T00:00Z" });
    await expect(
      h.service.finalize(actor, "2026-11-02", input),
    ).rejects.toThrow("earliest");
    expect(h.committed).toHaveLength(0);
  });
  it("tampered eligibility or closed days fail without allocations", async () => {
    for (const opts of [{ tamper: true }, { closed: true }]) {
      const h = fixture(opts);
      await expect(
        h.service.finalize(actor, "2026-11-01", input),
      ).rejects.toThrow();
      expect(h.committed).toHaveLength(0);
    }
  });
  it("transaction failure cannot publish partial day or grant", async () => {
    const h = fixture({ failInsert: true });
    await expect(
      h.service.finalize(actor, "2026-11-01", input),
    ).rejects.toThrow("write failed");
    expect(h.committed).toHaveLength(0);
  });
  it("exact retry returns original receipt without another candidate read/write", async () => {
    const snapshot = { allocated: "200" },
      h = fixture({
        retry: {
          fingerprint: adDigest({ actor, day: "2026-11-01", ...input }),
          snapshot,
        },
      });
    expect(await h.service.finalize(actor, "2026-11-01", input)).toBe(snapshot);
    expect(h.committed).toHaveLength(0);
  });
  it("a signed invalid fraud assessment before cutoff excludes monetary and badge rewards", async () => {
    const h = fixture({ fraud: true });
    expect(await h.service.finalize(actor, "2026-11-01", input)).toMatchObject({
      allocated: "0",
    });
    expect(
      h.committed.some((c) => c.sql.startsWith("INSERT INTO cfig_ledger")),
    ).toBe(false);
  });
  it("publishes frozen budget, day, event allocation and virtual grant atomically; no wallet/points writes", async () => {
    const h = fixture();
    expect(await h.service.finalize(actor, "2026-11-01", input)).toMatchObject({
      allocated: "200",
      candidateCount: 1,
      outstandingAfter: "200",
    });
    expect(h.committed.map((c) => c.sql.split("(")[0].trim())).toEqual([
      "INSERT INTO cfig_period_budgets",
      "INSERT INTO cfig_finalizations",
      "INSERT INTO cfig_allocations",
      "INSERT INTO cfig_ledger",
    ]);
    expect(
      h.commands.some((c) =>
        /INSERT INTO (billing|rewards_points|rewards_fund)/.test(c.sql),
      ),
    ).toBe(false);
  });
});
