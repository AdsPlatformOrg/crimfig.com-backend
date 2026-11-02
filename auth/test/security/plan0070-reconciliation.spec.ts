import { PgDialect } from "drizzle-orm/pg-core";
import { RewardProgramService } from "../../../api/billing-api/src/modules/rewards/reward-program.service";
import * as policy from "../../../api/billing-api/src/modules/rewards/reward-program-policy";
import { adDigest } from "../../../shared/src/ad-authority-policy";
const actor = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  source = "00000000-0000-4000-8000-000000000003";
const dialect = new PgDialect();
describe("independent source reconciliation never invents funding", () => {
  const oldKey = process.env.ADS_EVIDENCE_HASH_SECRET,
    oldId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
  beforeEach(() => {
    process.env.ADS_EVIDENCE_HASH_SECRET =
      "unit-only-reconciliation-key-at-least-32-bytes";
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
    const snapshot = {
      fundId: actor,
      amountCents: "100",
      fundLedgerId: source,
      sourceRef: "settled-original",
    };
    const review = {
      id: source,
      prepared_by: other,
      kind: "backing",
      source_id: source,
      source_hash: adDigest(snapshot),
      source_snapshot: snapshot,
      reason: "Verified bank reconciliation evidence reference",
      expires_at: "2026-11-10T00:00:00Z",
      ...patch.review,
    };
    const writes: { sql: string; params: any[] }[] = [];
    const execute = jest.fn(async (q: any) => {
      const query = dialect.sqlToQuery(q);
      const text = query.sql;
      if (/^(INSERT|UPDATE|DELETE)/.test(text)) writes.push(query);
      let rows: any[] = [];
      if (text.includes("clock_timestamp() AS now"))
        rows = [{ now: "2026-11-05T00:00:00Z" }];
      else if (text.includes("reward_reconciliation_reviews WHERE id"))
        rows = [review];
      else if (text.includes("rewards_fund_ledger WHERE id"))
        rows = patch.noLedger
          ? []
          : [
              {
                id: source,
                fund_id: actor,
                type: "sweep_in",
                to_bucket: "available",
                from_bucket: patch.internal
                  ? "allocated"
                  : "external_settled_pool",
                source_ref: "settled-original",
                amount_cents: patch.changed ? "101" : "100",
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
    jest.spyOn(service as any, "settings").mockResolvedValue({
      reserve_floor_percent: 20,
      reserve_floor_min_cents: 10000,
    });
    jest.spyOn(service as any, "fund").mockResolvedValue({
      id: actor,
      cash_balance_usd_cents: "20000",
      available_usd_cents: "20000",
      allocated_usd_cents: "0",
      funded_pending_usd_cents: "0",
    });
    return { service, writes, review };
  }
  const input = {
    requestId: actor,
    kind: "backing",
    sourceId: source,
    reason: "Matched independent bank statement reference",
    expiresAt: "2026-11-10T00:00:00Z",
  };
  it.each([{ noLedger: true }, { internal: true }])(
    "rejects missing or internal recycling sources %j without writes",
    async (patch) => {
      const f = fixture(patch);
      await expect(
        f.service.prepareReconciliation(actor, input),
      ).rejects.toThrow(/inbound/);
      expect(f.writes).toEqual([]);
    },
  );
  it("rejects self approval without creating proof", async () => {
    const f = fixture({ review: { prepared_by: actor } });
    await expect(
      f.service.approveReconciliation(actor, source, { requestId: actor }),
    ).rejects.toThrow(/Independent/);
    expect(f.writes).toEqual([]);
  });
  it.each([
    { changed: true },
    { review: { expires_at: "2026-11-01T00:00:00Z" } },
  ])("rejects changed or expired evidence %j", async (patch) => {
    const f = fixture(patch);
    await expect(
      f.service.approveReconciliation(actor, source, { requestId: actor }),
    ).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it("derives the source amount, ignoring caller-supplied money values", async () => {
    const f = fixture();
    const result = await f.service.prepareReconciliation(actor, {
      ...input,
      amountCents: "999999999",
    });
    expect(result.snapshot).toMatchObject({
      amountCents: "100",
      fundLedgerId: source,
    });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].sql).toMatch(
      /^INSERT INTO reward_reconciliation_reviews/,
    );
  });
  it("independent approval creates only signed proof and append-only approval receipts", async () => {
    const f = fixture();
    const result = await f.service.approveReconciliation(actor, source, {
      requestId: actor,
    });
    expect(result).toMatchObject({
      status: "reconciled_evidence",
      cashCredited: "0",
    });
    expect(f.writes).toHaveLength(2);
    expect(
      f.writes.every((w) =>
        /^INSERT INTO (billing_provider_events|reward_reconciliation_approvals)/.test(
          w.sql,
        ),
      ),
    ).toBe(true);
  });
  it("ungranted reviewers cannot prepare reconciliation", async () => {
    const f = fixture();
    (f.service as any).financial.authorize.mockRejectedValue(
      new Error("No grant"),
    );
    await expect(f.service.prepareReconciliation(actor, input)).rejects.toThrow(
      /No grant/,
    );
    expect(f.writes).toEqual([]);
  });
});

describe("audited legacy point clearance appends state transitions", () => {
  const {
    evidenceSignature,
  } = require("../../../shared/src/ad-authority-policy");
  const oldKey = process.env.ADS_EVIDENCE_HASH_SECRET,
    oldId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
  beforeEach(() => {
    process.env.ADS_EVIDENCE_HASH_SECRET =
      "unit-only-clearance-evidence-key-at-least-32-bytes";
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
    const lot = {
      id: source,
      user_id: other,
      lot_id: "original-lot",
      delta_points: 100,
      state: "pending",
      earned_at: new Date(patch.early ? "2026-11-04" : "2026-11-01"),
      expires_at: new Date("2027-11-01"),
      rate_version: 1,
    };
    const payload = {
      grantLedgerId: source,
      userId: other,
      points: "100",
      outcome: "eligible",
      expiresAt: patch.expired ? "2026-11-01" : "2026-11-10",
      reviewers: patch.selfReview ? [actor, other] : [actor, source],
    };
    const envelope = {
      payload,
      keyId: "test",
      signature: patch.forged
        ? "bad"
        : evidenceSignature({ ...payload, keyId: "test" }),
    };
    const writes: { sql: string; params: any[] }[] = [];
    const execute = jest.fn(async (q: any) => {
      const query = dialect.sqlToQuery(q),
        text = query.sql;
      if (/^(INSERT|UPDATE|DELETE)/.test(text)) writes.push(query);
      let rows: any[] = [];
      if (text.includes("clock_timestamp() AS now"))
        rows = [{ now: "2026-11-05T00:00:00Z" }];
      else if (text.includes("reward_program_issues WHERE request_id"))
        rows = [];
      else if (text.includes("reward_program_issues WHERE source_ref"))
        rows = patch.duplicate ? [{ id: source }] : [];
      else if (text.includes("FROM rewards_points_ledger WHERE id"))
        rows = [lot];
      else if (text.includes("billing_provider_events"))
        rows = [{ raw_payload: envelope }];
      else if (text.includes("rewards_points_balances WHERE user_id"))
        rows = [
          {
            pending_points: 100,
            available_points: 0,
            is_rewards_suspended: false,
          },
        ];
      else if (text.includes("SELECT status FROM users"))
        rows = [{ status: "ACTIVE" }];
      else if (text.includes("sum(a.amount_cents")) rows = [{ units: "1000" }];
      else if (text.includes("sum(pending_points)"))
        rows = [{ pending: "100", available: "0" }];
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
      .mockResolvedValue({
        pending_hold_hours: 72,
        reserve_floor_percent: 20,
        reserve_floor_min_cents: 10000,
      });
    jest
      .spyOn(service as any, "fund")
      .mockResolvedValue({
        id: actor,
        cash_balance_usd_cents: "21100",
        available_usd_cents: "20000",
        allocated_usd_cents: "0",
        funded_pending_usd_cents: patch.noBacking ? "1000" : "1100",
      });
    return { service, writes };
  }
  const input = { requestId: actor, proofId: source };
  it.each([
    { early: true },
    { forged: true },
    { expired: true },
    { selfReview: true },
    { duplicate: true },
    { noBacking: true },
  ])(
    "rejects immature/invalid/expired/self-reviewed/replayed/unbacked lot %j before writes",
    async (patch) => {
      const f = fixture(patch);
      await expect(
        f.service.clearLegacy(actor, source, input),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );
  it("appends pending debit and available credit without editing the original grant or lifetime earned", async () => {
    const f = fixture();
    const result = await f.service.clearLegacy(actor, source, input);
    expect(result).toMatchObject({
      sourceLedgerId: source,
      userId: other,
      points: "100",
    });
    expect(
      f.writes.filter((w) =>
        w.sql.startsWith("INSERT INTO rewards_points_ledger"),
      ),
    ).toHaveLength(2);
    expect(
      f.writes.some((w) => w.sql.startsWith("UPDATE rewards_points_ledger")),
    ).toBe(false);
    expect(
      f.writes.find((w) => w.sql.startsWith("UPDATE rewards_points_balances"))
        ?.sql,
    ).not.toMatch(/lifetime_earned/);
  });
});
