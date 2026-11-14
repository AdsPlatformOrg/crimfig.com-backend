import { PgDialect } from "drizzle-orm/pg-core";
import { RewardProgramService } from "../../../api/billing-api/src/modules/rewards/reward-program.service";
import * as policy from "../../../api/billing-api/src/modules/rewards/reward-program-policy";
import { canonicalPaidRewardLoops } from "../../../shared/src/rewards-performance-policy";
import { evidenceSignature } from "../../../shared/src/ad-authority-policy";
const user = "00000000-0000-4000-8000-000000000001",
  serve = "00000000-0000-4000-8000-000000000002",
  promoter = "00000000-0000-4000-8000-000000000003",
  campaign = "00000000-0000-4000-8000-000000000004",
  eventId = "00000000-0000-4000-8000-000000000005";
const dialect = new PgDialect();
describe("audited paid loop issuance and independent prestige", () => {
  const oldKey = process.env.ADS_EVIDENCE_HASH_SECRET,
    oldId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
  beforeEach(() => {
    process.env.ADS_EVIDENCE_HASH_SECRET =
      "unit-only-paid-event-evidence-key-at-least-32-bytes";
    process.env.ADS_EVIDENCE_HASH_KEY_ID = "test";
    jest.spyOn(policy, "gate").mockReturnValue(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (oldKey === undefined) delete process.env.ADS_EVIDENCE_HASH_SECRET;
    else process.env.ADS_EVIDENCE_HASH_SECRET = oldKey;
    if (oldId === undefined) delete process.env.ADS_EVIDENCE_HASH_KEY_ID;
    else process.env.ADS_EVIDENCE_HASH_KEY_ID = oldId;
  });
  function fixture(patch: any = {}) {
    const e = {
      id: eventId,
      event_id: "browser-observation",
      serve_id: serve,
      promoter_id: promoter,
      type: patch.type ?? "click",
      is_valid: true,
      created_at: new Date("2026-11-01T00:00:00Z"),
    };
    const v = {
      id: serve,
      promoter_id: promoter,
      campaign_id: campaign,
      inventory_class: patch.house ? "house" : "paid",
      delivery_mode: patch.shadow ? "shadow" : "normal",
      opportunity_reservation_id: serve,
    };
    const signed = {
      id: campaign,
      eventId,
      campaignId: campaign,
      requestId: campaign,
      actorId: patch.selfAudit ? user : campaign,
      policyVersion: "unit-audit",
      outcome: "eligible",
      reasonCodes: ["VALIDATED"],
      features: { integrity: true },
      supersedesId: null,
      keyId: "test",
    };
    const assessment = Object.fromEntries(
      Object.entries(signed).map(([k, val]) => [
        k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
        val,
      ]),
    );
    Object.assign(assessment, {
      created_at: new Date("2026-11-01T01:00:00Z"),
      record_hash: patch.forged ? "invalid" : evidenceSignature(signed),
    });
    const payload = {
      eventId: e.event_id,
      serveId: serve,
      type: e.type,
      serverReceivedAt: e.created_at.toISOString(),
    };
    const j = {
      eventId,
      partition: "ads:2026-11-01",
      previousHash: null,
      payload,
      keyId: "test",
    };
    const journal = {
      event_id: eventId,
      partition: j.partition,
      previous_hash: null,
      payload,
      key_id: "test",
      record_hash: evidenceSignature(j),
    };
    const r = {
      id: serve,
      pricing_model: patch.model ?? "cpc",
      claim_event_id: eventId,
      serve_id: serve,
      promoter_id: promoter,
      state: "CLAIMED",
      is_simulated: false,
      settled_at: patch.unsettled ? null : new Date("2026-11-01T02:00:00Z"),
    };
    const writes: { sql: string; params: any[] }[] = [];
    const execute = jest.fn(async (q: any) => {
      const query = dialect.sqlToQuery(q),
        s = query.sql;
      if (/^(INSERT|UPDATE)/.test(s)) writes.push(query);
      let rows: any[] = [];
      if (s.includes("clock_timestamp() AS now"))
        rows = [{ now: "2026-11-05T00:00:00Z" }];
      else if (s.includes("reward_performance_receipts WHERE event_id"))
        rows = [];
      else if (s.includes("reward_program_allocations WHERE id"))
        rows = [
          {
            id: campaign,
            approved_at: new Date(),
            created_by: campaign,
            approved_by: serve,
            proof_id: campaign,
            amount_cents: "1000",
            policy_snapshot: {
              effectiveFrom: "2026-11-01T00:00:00Z",
              paidLoops: canonicalPaidRewardLoops(),
            },
          },
        ];
      else if (s.includes("FROM ads_interactions")) rows = [e];
      else if (s.includes("FROM ads_serves")) rows = [v];
      else if (s.includes("FROM ads_opportunity_reservations")) rows = [r];
      else if (s.includes("FROM ads_settlement_claims"))
        rows = [
          {
            id: serve,
            batch_id: campaign,
            serve_id: serve,
            promoter_id: promoter,
          },
        ];
      else if (s.includes("FROM ads_promoter_settlement_items"))
        rows = [
          { id: serve, billing_transaction_id: campaign, earned_usd_cents: 10 },
        ];
      else if (s.includes("FROM ads_promoters"))
        rows = [{ id: promoter, user_id: user }];
      else if (s.includes("FROM ads_event_assessments")) rows = [assessment];
      else if (s.includes("FROM ads_evidence_records")) rows = [journal];
      else if (s.includes("FROM billing_transactions"))
        rows = [
          {
            provider: "internal",
            type: "ads_earning",
            status: "completed",
            user_id: patch.wrongCash ? campaign : user,
            amount_usd_cents: 10,
            metadata: JSON.stringify({
              version: 3,
              kind: "funded_ad_earning",
              itemId: serve,
              batchId: campaign,
              campaignId: campaign,
              promoterId: promoter,
            }),
          },
        ];
      else if (s.includes("ads_rewards_suspension_audit"))
        rows = patch.paused ? [{ scope: "global", action: "pause" }] : [];
      else if (s.includes("count(*)"))
        rows = [
          {
            total: patch.prior ?? (r.pricing_model === "cpc" ? "99" : "19999"),
            issued: patch.issued ?? "0",
          },
        ];
      return { rows };
    });
    const db: any = {
      execute,
      transaction: jest.fn(async (fn) => fn({ execute })),
    };
    const service = new RewardProgramService(db, {
      authorize: jest.fn(),
    } as any);
    jest
      .spyOn(service as any, "settings")
      .mockResolvedValue({ points_expiry_days: 365 });
    jest.spyOn(service as any, "fund").mockResolvedValue({});
    jest.spyOn(service as any, "backing").mockResolvedValue({});
    jest.spyOn(service as any, "capacity").mockImplementation(async () => {
      if (patch.exhausted)
        throw new policy.RewardCapacityUnavailable("Program backing exhausted");
      return {
        settings: { points_expiry_days: 365 },
        fund: {
          id: campaign,
          cash_balance_usd_cents: "1000",
          available_usd_cents: "0",
          allocated_usd_cents: "0",
          funded_pending_usd_cents: "1000",
        },
      };
    });
    return { service, writes, db };
  }
  const input = { requestId: eventId, allocationId: campaign };
  it.each([
    { type: "viewable_impression" },
    { model: "cpm", type: "click" },
    { house: true },
    { shadow: true },
    { forged: true },
    { unsettled: true },
    { selfAudit: true },
    { wrongCash: true },
    { paused: true },
  ])(
    "rejects wrong metric or invalid/unsettled source %j without writes",
    async (patch) => {
      const f = fixture(patch);
      await expect(
        f.service.processPaid(campaign, eventId, input),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );
  it("exhausted backing records progress and prestige without issuing unfunded points", async () => {
    const f = fixture({ exhausted: true });
    await expect(
      f.service.processPaid(campaign, eventId, input),
    ).resolves.toMatchObject({
      fundingStatus: "unfunded_no_points_issued",
      pointsIssued: "0",
    });
    expect(
      f.writes.some((w) => w.sql.startsWith("INSERT INTO rewards_badges")),
    ).toBe(true);
    expect(
      f.writes.some(
        (w) =>
          w.sql.startsWith("INSERT INTO rewards_points_ledger") ||
          w.sql.startsWith("UPDATE rewards_fund"),
      ),
    ).toBe(false);
  });
  it.each([
    { model: "cpc", type: "click" },
    { model: "cpm", type: "viewable_impression" },
  ])(
    "uses the canonical settled %j loop to issue 10 backed points",
    async (patch) => {
      const f = fixture(patch);
      const result = await f.service.processPaid(campaign, eventId, input);
      expect(result).toMatchObject({
        pointsIssued: "10",
        fundingStatus: "funded",
      });
      expect(
        f.writes.filter((w) =>
          w.sql.startsWith("INSERT INTO rewards_points_ledger"),
        ),
      ).toHaveLength(1);
      expect(
        f.writes.filter((w) =>
          w.sql.startsWith("INSERT INTO reward_program_issues"),
        ),
      ).toHaveLength(1);
      expect(f.db.transaction).toHaveBeenCalledTimes(1);
    },
  );
  it("below-threshold CPM activity remains progress with no monetary writes", async () => {
    const f = fixture({
      model: "cpm",
      type: "viewable_impression",
      prior: "999",
    });
    await expect(
      f.service.processPaid(campaign, eventId, input),
    ).resolves.toMatchObject({
      pointsIssued: "0",
      fundingStatus: "below_threshold",
    });
    expect(
      f.writes.some((w) =>
        w.sql.startsWith("INSERT INTO rewards_points_ledger"),
      ),
    ).toBe(false);
  });
});
