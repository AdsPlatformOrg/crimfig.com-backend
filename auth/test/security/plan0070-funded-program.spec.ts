import { PgDialect } from "drizzle-orm/pg-core";
import { RewardProgramService } from "../../../api/billing-api/src/modules/rewards/reward-program.service";
import {
  positive,
  conversionQuote,
  reserveFloor,
  gate,
} from "../../../api/billing-api/src/modules/rewards/reward-program-policy";
import { RewardProgramController } from "../../../api/billing-api/src/modules/rewards/reward-program.controller";
const id = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002";
const dialect = new PgDialect();
function fixture(respond: (text: string, params: any[]) => any[] = () => []) {
  const writes: string[] = [];
  const execute = jest.fn(async (q: any) => {
    const v = dialect.sqlToQuery(q);
    if (/^(INSERT|UPDATE|DELETE)/i.test(v.sql)) writes.push(v.sql);
    return {
      rows: v.sql.includes("clock_timestamp() AS now")
        ? [{ now: "2026-11-04T00:00:00Z" }]
        : respond(v.sql, v.params),
    };
  });
  const db: any = {
    execute,
    transaction: jest.fn(async (fn) => fn({ execute })),
  };
  const finance: any = { authorize: jest.fn(async () => undefined) };
  return {
    service: new RewardProgramService(db, finance),
    db,
    finance,
    writes,
  };
}
describe("PLAN-0070 funded program safeguards", () => {
  it.each(["0", "-1", "1.1", "01", "1e8", 123, null])(
    "rejects malformed integer units %s",
    (v) => expect(() => positive(v)).toThrow(),
  );
  it.each(["funding", "paid", "conversion"] as const)(
    "cannot enable %s using environment alone",
    (kind) =>
      expect(
        gate(kind, {
          BILLING_REWARDS_FUNDING_ENABLED: "true",
          BILLING_REWARDS_PAID_ENABLED: "true",
          BILLING_REWARDS_CONVERSION_ENABLED: "true",
        }),
      ).toBe(false),
  );
  it("rejects below minimum, insufficient balance, monthly cap and invalid valuation", () => {
    expect(() => conversionQuote("99999999", 100, 100000000n, 0n)).toThrow();
    expect(() => conversionQuote("100000000", 100, 99999999n, 0n)).toThrow();
    expect(() => conversionQuote("100000000", 100, 100000000n, 100n)).toThrow();
    expect(() => conversionQuote("100000000", 0, 100000000n, 0n)).toThrow();
  });
  it("preserves exact fractional residuals", () =>
    expect(conversionQuote("199999999", 100, 200000000n, 99n)).toEqual({
      points: 1n,
      debited: 100000000n,
      residual: 99999999n,
    }));
  it("rejects cash bucket mismatch", () =>
    expect(() =>
      reserveFloor(
        {
          cash_balance_usd_cents: "20000",
          available_usd_cents: "19999",
          allocated_usd_cents: "0",
          funded_pending_usd_cents: "0",
        },
        { reserve_floor_percent: 20, reserve_floor_min_cents: 10000 },
      ),
    ).toThrow());
  it("uses the greater absolute or rounded percentage floor", () => {
    const f = {
      cash_balance_usd_cents: "20001",
      available_usd_cents: "20001",
      allocated_usd_cents: "0",
      funded_pending_usd_cents: "0",
    };
    expect(
      reserveFloor(f, {
        reserve_floor_percent: 20,
        reserve_floor_min_cents: 10000,
      }),
    ).toBe(10000n);
    expect(
      reserveFloor(f, {
        reserve_floor_percent: 50,
        reserve_floor_min_cents: 0,
      }),
    ).toBe(10001n);
  });
  it.each(["convert", "processPaid", "clearLegacy"] as const)(
    "disabled %s makes no writes",
    async (name) => {
      const f = fixture();
      const input = {
        requestId: id,
        allocationId: id,
        policyId: id,
        microCfig: "100000000",
        proofId: id,
      };
      await expect(
        name === "convert"
          ? f.service.convert(id, input)
          : f.service[name](other, id, input),
      ).rejects.toThrow(/disabled/);
      expect(f.writes).toEqual([]);
    },
  );
  it("returns identical conversion retries while activation is off", async () => {
    const { adDigest } = require("../../../shared/src/ad-authority-policy");
    const input = {
        requestId: id,
        allocationId: id,
        policyId: id,
        microCfig: "100000000",
      },
      payload = { id, points: "1" };
    const fingerprint = adDigest({ userId: id, ...input });
    const f = fixture((q) =>
      q.includes("reward_program_issues WHERE request_id")
        ? [{ fingerprint, payload }]
        : [],
    );
    await expect(f.service.convert(id, input)).resolves.toEqual(payload);
    expect(f.writes).toEqual([]);
  });
  it("rejects changed retry identity", async () => {
    const f = fixture((q) =>
      q.includes("reward_program_issues WHERE request_id")
        ? [{ fingerprint: "different", payload: {} }]
        : [],
    );
    await expect(
      f.service.convert(id, {
        requestId: id,
        allocationId: id,
        policyId: id,
        microCfig: "100000000",
      }),
    ).rejects.toThrow(/identity changed/);
    expect(f.writes).toEqual([]);
  });
  it("binds HTTP conversion to authenticated owner", async () => {
    const service: any = { convert: jest.fn(async () => ({ points: "1" })) };
    await new RewardProgramController(service).convert({ user: { sub: id } }, {
      userId: other,
      requestId: id,
    } as any);
    expect(service.convert).toHaveBeenCalledWith(id, expect.anything());
  });
  it("scopes receipt query to authenticated owner", async () => {
    const f = fixture();
    await expect(f.service.receipt(id, other)).rejects.toThrow(/not found/);
    expect(dialect.sqlToQuery(f.db.execute.mock.calls[0][0]).params).toEqual([
      id,
      other,
    ]);
  });
});

describe("funded conversion authority with server-owned source fixtures", () => {
  const policy = require("../../../api/billing-api/src/modules/rewards/reward-program-policy");
  const evidence = require("../../../shared/src/ad-authority-policy");
  const reviewer = "00000000-0000-4000-8000-000000000003";
  const oldKey = process.env.ADS_EVIDENCE_HASH_SECRET,
    oldId = process.env.ADS_EVIDENCE_HASH_KEY_ID;
  beforeEach(() => {
    process.env.ADS_EVIDENCE_HASH_SECRET =
      "unit-only-funded-evidence-key-at-least-32-bytes";
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
  function authority(patch: any = {}) {
    const fund = {
      id,
      cash_balance_usd_cents: "101000",
      available_usd_cents: "100000",
      allocated_usd_cents: "0",
      funded_pending_usd_cents: "1000",
    };
    const snapshot = {
      ...policy.fundedPolicy(),
      housePolicyId: id,
      cfigPerPoint: "100",
      effectiveFrom: "2026-11-01T00:00:00Z",
    };
    const a = {
      id,
      program: "house_conversion",
      approved_at: "2026-11-01T00:00:00Z",
      created_by: other,
      approved_by: reviewer,
      proof_id: other,
      amount_cents: "1000",
      policy_snapshot: snapshot,
      ...patch.allocation,
    };
    const payload = {
      fundId: id,
      amountCents: "1000",
      fundLedgerId: other,
      reviewers: [other, reviewer],
      reference: "unit-fixture-only",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const proof = {
      raw_payload: {
        payload,
        keyId: "test",
        signature: evidence.evidenceSignature({ ...payload, keyId: "test" }),
      },
    };
    const f = fixture((q, params) => {
      if (q.includes("reward_program_issues WHERE request_id")) return [];
      if (q.includes("reward_program_allocations WHERE id")) return [a];
      if (q.includes("ads_promoters WHERE user_id"))
        return patch.noOwner ? [] : [{ id: other }];
      if (q.includes("FROM cfig_ledger"))
        return [{ event_id: reviewer, units: patch.units ?? "100000000" }];
      if (q.includes("kind='cfig_conversion'"))
        return [{ points: patch.monthly ?? "0" }];
      if (q.includes("FROM rewards_fund_settings"))
        return [
          {
            version: 1,
            approved_by: [other, reviewer],
            ads_rewards_global_paused: false,
            reserve_floor_percent: 20,
            reserve_floor_min_cents: 10000,
            per_user_daily_cap_points: 200,
            per_user_monthly_cap_points: 3000,
            daily_emission_cap_points: 50000,
            monthly_emission_cap_points: 1000000,
            pending_hold_hours: 72,
            points_expiry_days: 365,
          },
        ];
      if (q.includes("FROM rewards_fund WHERE currency")) return [fund];
      if (q.includes("billing_provider_events"))
        return patch.badProof ? [] : [proof];
      if (q.includes("rewards_fund_ledger WHERE id"))
        return [{ fund_id: id, type: "sweep_in", amount_cents: "1000" }];
      if (q.includes("sum(a.amount_cents")) return [{ units: "1000" }];
      if (q.includes("sum(pending_points)"))
        return [{ pending: "0", available: "0" }];
      if (q.includes("sum(points)") && q.includes("allocation_id"))
        return [{ units: patch.exhausted ? "1000" : "0" }];
      if (q.includes("rewards_points_balances WHERE user_id"))
        return [
          {
            available_points: 0,
            lifetime_earned_points: 0,
            is_rewards_suspended: patch.suspended ?? false,
          },
        ];
      if (q.includes("SELECT status FROM users")) return [{ status: "ACTIVE" }];
      if (q.includes("SELECT cap_points"))
        return [{ cap_points: patch.cap ?? 1000 }];
      if (q.includes("sum(delta_points)"))
        return [{ total: "0", personal: "0" }];
      return [];
    });
    return { ...f, a, fund, proof };
  }
  const input = {
    requestId: id,
    allocationId: id,
    policyId: id,
    microCfig: "199999999",
  };
  it.each([
    { noOwner: true },
    { allocation: { policy_snapshot: { housePolicyId: other } } },
    { units: "99999999" },
    { monthly: "100" },
    { badProof: true },
    { suspended: true },
    { exhausted: true },
  ])(
    "rejects owner/cohort/balance/cap/backing/suspension %j with no financial mutations",
    async (patch) => {
      const f = authority(patch);
      await expect(f.service.convert(id, input)).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );
  it("rejects issuance beyond frozen limits before any debit", async () => {
    const f = authority({ cap: 0 });
    await expect(f.service.convert(id, input)).rejects.toThrow(/cap/);
    expect(
      f.writes.every((q) =>
        q.startsWith("INSERT INTO reward_issuance_periods"),
      ),
    ).toBe(true);
  });
  it("converts exact cleared units using existing points/fund tables and leaves residual", async () => {
    const f = authority();
    const receipt = await f.service.convert(id, input);
    expect(receipt).toMatchObject({
      userId: id,
      requestId: id,
      points: "1",
      debitedMicroCfig: "100000000",
      residualMicroCfig: "99999999",
    });
    expect(
      f.writes.filter((q) => q.startsWith("INSERT INTO cfig_ledger")),
    ).toHaveLength(1);
    expect(
      f.writes.filter((q) => q.startsWith("INSERT INTO rewards_points_ledger")),
    ).toHaveLength(1);
    expect(
      f.writes.filter((q) => q.startsWith("INSERT INTO reward_program_issues")),
    ).toHaveLength(1);
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
  });
  it("rejects funding approval by the proposer", async () => {
    const f = authority({
      allocation: { created_by: other, approved_at: null },
    });
    await expect(
      f.service.approve(other, id, { requestId: id }),
    ).rejects.toThrow(/Independent/);
    expect(f.writes).toEqual([]);
  });
  it("rejects malformed or unprocessed reconciliation proof", async () => {
    const f = authority({ badProof: true });
    await expect(
      (f.service as any).backing({ execute: f.db.execute }, other, f.fund, 1n),
    ).rejects.toThrow(/signed backing/);
    expect(f.writes).toEqual([]);
  });
  it("rejects an unsigned amount even with a matching inbound ledger", async () => {
    const f = authority();
    f.proof.raw_payload.payload.amountCents = "999999";
    await expect(
      (f.service as any).backing({ execute: f.db.execute }, other, f.fund, 1n),
    ).rejects.toThrow(/signed backing/);
  });
  it("credit persistence failure rejects the transaction rather than acknowledging a conversion", async () => {
    const f = authority();
    const original = f.db.execute.getMockImplementation();
    f.db.execute.mockImplementation(async (q: any) => {
      if (
        dialect
          .sqlToQuery(q)
          .sql.startsWith("INSERT INTO rewards_points_ledger")
      )
        throw new Error("unit persistence fault");
      return original(q);
    });
    await expect(f.service.convert(id, input)).rejects.toThrow(
      "unit persistence fault",
    );
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(
      f.writes.some((q) => q.startsWith("INSERT INTO reward_program_issues")),
    ).toBe(false);
  });
});
