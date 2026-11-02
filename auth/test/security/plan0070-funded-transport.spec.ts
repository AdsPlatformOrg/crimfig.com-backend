import { ConfigService } from "@nestjs/config";
import { FundedRewardsClient } from "../../../api/ads-api/src/modules/billing/funded-rewards.client";
import { RewardProgramInternalController } from "../../../api/billing-api/src/modules/rewards/reward-program-internal.controller";
import {
  RewardProgramWorker,
  paidRewardRequestId,
} from "../../../api/billing-api/src/modules/rewards/reward-program.worker";
import { PointsEngineService } from "../../../api/billing-api/src/modules/rewards/points-engine.service";
import { RedemptionService } from "../../../api/billing-api/src/modules/rewards/redemption.service";
import { paidBadgeAwards } from "../../../shared/src/rewards-performance-policy";
const id = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002";
const input = {
  requestId: id,
  allocationId: other,
  policyId: id,
  microCfig: "100000000",
};
const config = (key = "unit-internal-key") =>
  new ConfigService({
    BILLING_API_URL: "https://billing.invalid/api/v1",
    INTERNAL_ECOSYSTEM_KEY: key,
  });
afterEach(() => jest.restoreAllMocks());
describe("funded authority transport fails closed", () => {
  it("missing internal credentials makes no network call", async () => {
    const call = jest.spyOn(global, "fetch");
    await expect(
      new FundedRewardsClient(config("")).command(id, "convert", input),
    ).rejects.toThrow(/unavailable/);
    expect(call).not.toHaveBeenCalled();
  });
  it.each([
    "https://user:secret@billing.invalid",
    "ftp://billing.invalid",
    "https://billing.invalid/api/v1?key=wrong",
    "https://billing.invalid/other",
  ])("rejects unsafe authority URL %s", (url) =>
    expect(
      () =>
        new FundedRewardsClient(new ConfigService({ BILLING_API_URL: url })),
    ).toThrow(),
  );
  it.each([403, 409, 500])(
    "rejects HTTP %s without fabricated success or retries",
    async (status) => {
      const call = jest
        .spyOn(global, "fetch")
        .mockResolvedValue({
          ok: false,
          status,
          json: async () => ({}),
        } as any);
      await expect(
        new FundedRewardsClient(config()).command(id, "convert", input),
      ).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { userId: other },
    { requestId: other },
    { allocationId: id },
    { policyId: other },
    { authorityVersion: "wrong" },
  ])("rejects mismatched immutable conversion receipt %j", async (patch) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "success",
          data: {
            authorityVersion: "rewards-program-v1",
            userId: id,
            ...input,
            ...patch,
          },
        }),
      } as any);
    await expect(
      new FundedRewardsClient(config()).command(id, "convert", input),
    ).rejects.toThrow(/unconfirmed/);
  });
  it("accepts only the bound conversion acknowledgement and sends a bounded request", async () => {
    const data = {
      authorityVersion: "rewards-program-v1",
      userId: id,
      ...input,
      points: "1",
    };
    const call = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data }),
      } as any);
    await expect(
      new FundedRewardsClient(config()).command(id, "convert", input),
    ).resolves.toEqual(data);
    expect(call.mock.calls[0][1]).toMatchObject({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ actorId: id, action: "convert", input }),
    });
  });
  it("internal route rejects missing/wrong keys before invoking financial services", async () => {
    const old = process.env.INTERNAL_ECOSYSTEM_KEY;
    process.env.INTERNAL_ECOSYSTEM_KEY = "unit-only-internal-key";
    try {
      const service: any = { convert: jest.fn() };
      const controller = new RewardProgramInternalController(service);
      for (const key of ["", "wrong"])
        await expect(
          controller.command(key, { actorId: id, action: "convert", input }),
        ).rejects.toThrow(/authorization|authority/);
      expect(service.convert).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) delete process.env.INTERNAL_ECOSYSTEM_KEY;
      else process.env.INTERNAL_ECOSYSTEM_KEY = old;
    }
  });
  it("disabled worker makes no database or provider calls", async () => {
    const db: any = { execute: jest.fn() },
      service: any = { processPaid: jest.fn() };
    await new RewardProgramWorker(db, service).reconcile();
    expect(db.execute).not.toHaveBeenCalled();
    expect(service.processPaid).not.toHaveBeenCalled();
  });
  it("stable worker identities bind both source and allocation", () => {
    expect(paidRewardRequestId(id, other)).toBe(paidRewardRequestId(id, other));
    expect(paidRewardRequestId(id, other)).not.toBe(
      paidRewardRequestId(other, id),
    );
    expect(paidRewardRequestId(id, other)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
describe("existing funded engine safeguards", () => {
  it("legacy clearance cannot bypass identity/audit using age alone", async () => {
    await expect(
      new PointsEngineService({} as any, {} as any).clearPendingPoints(id),
    ).rejects.toThrow(/source-bound/);
  });
  it("changed redemption retry cannot claim another owner or amount", async () => {
    const prior = { userId: other, pointsRedeemed: 1000 };
    const db: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [prior] }) }),
      }),
      transaction: jest.fn(),
    };
    await expect(
      new RedemptionService(db, {} as any).redeemToWallet(id, 1000, id),
    ).rejects.toThrow(/identity changed/);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, 1000.1, 999, 1101])(
    "rejects malformed redemption %s before writes",
    async (points) => {
      const db: any = { transaction: jest.fn() };
      await expect(
        new RedemptionService(db, {} as any).redeemToWallet(id, points, id),
      ).rejects.toThrow();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );
  it("paid badge tracks remain independent and have zero monetary awards", () => {
    expect(paidBadgeAwards("cpc", 9n)).toEqual([]);
    expect(paidBadgeAwards("cpm", 99n)).toEqual([]);
    const clicks = paidBadgeAwards("cpc", 1000000000000n),
      views = paidBadgeAwards("cpm", 1000000000000n);
    expect(clicks).toHaveLength(14);
    expect(views).toHaveLength(14);
    expect(
      clicks.every(
        (c) => c.pointsAwarded === 0 && !views.some((v) => v.key === c.key),
      ),
    ).toBe(true);
    expect(views[0].key).toBe("promo_impressions_100");
  });
});
