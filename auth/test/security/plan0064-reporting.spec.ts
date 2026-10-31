import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  AdminPerformanceController,
  performanceRates,
  performanceWindow,
} from "../../../api/ads-api/src/modules/delivery/admin-performance.controller";
import { ADS_ROLES_KEY } from "../../../api/ads-api/src/modules/security/ads-staff-grants";
import { DeliveryService } from "../../../api/ads-api/src/modules/delivery/delivery.service";
import { adsServes } from "@crimfig/database/schema";
import { AdminHouseAdsController } from "../../../api/ads-api/src/modules/delivery/admin-house-ads.controller";
describe("PLAN0064 reporting", () => {
  it.each([
    { range: "all" },
    { from: "bad" },
    { from: "2026-01-01", to: "2026-10-01" },
    { page: "0" },
    { limit: "101" },
    { websiteId: "not-uuid" },
    { inventory: "untrusted" },
  ])("rejects invalid scope before SQL: %j", async (q) => {
    const db = { transaction: jest.fn() };
    await expect(
      new AdminPerformanceController(db).websites(q as any),
    ).rejects.toThrow(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("keeps admin role metadata", () =>
    expect(
      Reflect.getMetadata(ADS_ROLES_KEY, AdminPerformanceController),
    ).toEqual(["ads_admin", "super_admin"]));
  it("preserves unknown denominators and genuine zeros", () => {
    expect(performanceRates({ serves: 0 }).ctr).toBeNull();
    expect(
      performanceRates({
        serves: 4,
        renders: 0,
        impressions: 2,
        clicks: 3,
        impressionClicks: 1,
        measurable: 2,
        viewable: 1,
      }),
    ).toMatchObject({
      renderRate: 0,
      ctr: 50,
      clickToServeRate: 75,
      viewability: 50,
    });
  });
  it("uses UTC half-open bounded windows", () =>
    expect(
      performanceWindow({}, new Date("2026-10-31T12:00:00Z")),
    ).toMatchObject({
      from: "2026-10-24T12:00:00.000Z",
      to: "2026-10-31T12:00:00.000Z",
      page: 1,
      limit: 25,
    }));
  it("queries deduplicated stages with relational attribution and keeps zero-activity inventory", async () => {
    const queries: string[] = [];
    const dialect = new PgDialect();
    let selected = 0;
    const tx = {
      execute: jest.fn(async (stmt) => {
        const query = dialect.sqlToQuery(stmt);
        queries.push(query.sql);
        if (query.sql.includes("SET LOCAL")) return { rows: [] };
        return {
          rows: [
            {
              serves: 3,
              renders: 2,
              impressions: 2,
              clicks: 1,
              impressionClicks: 1,
              total: 1,
            },
          ].slice(0, ++selected < 4 ? 1 : 0),
        };
      }),
    };
    const result = await new AdminPerformanceController({
      transaction: (cb: any) => cb(tx),
    }).house({});
    expect(result.data.summary.ctr).toBe(50);
    const compiled = queries.join("\n");
    expect(compiled).toContain("bool_or");
    expect(compiled).toContain("LEFT JOIN cohort");
    expect(compiled).toContain("e.serve_id=s.id");
    expect(compiled).not.toContain("imp_token");
    expect(compiled).not.toContain("is_valid");
    expect(tx.execute).toHaveBeenCalledTimes(6);
  });
});
describe("PLAN0064 catalog and upload contracts", () => {
  it("rejects invalid catalog pagination before reading", async () => {
    const db = { select: jest.fn() };
    await expect(
      new AdminHouseAdsController(db as any).listHouseCreatives({ page: "0" }),
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
  it("never records an image without media when the type defaults to image", async () => {
    const db = { insert: jest.fn() };
    await expect(
      new AdminHouseAdsController(db as any).createHouseCreative(
        { title: "Incomplete", headline: "Headline", bodyText: "Body" } as any,
        { user: { sub: "admin" } },
      ),
    ).rejects.toThrow("Image creative requires imageUrl");
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("rejects a missing, wrong-owner or unready uploaded asset before creating a creative", async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      insert: jest.fn(),
    };
    await expect(
      new AdminHouseAdsController(db as any).createHouseCreative(
        {
          title: "Test",
          imageAssetId: "asset",
          imageUrl: "https://example.com/api/v1/uploads/media/key",
        } as any,
        { user: { sub: "admin" } },
      ),
    ).rejects.toThrow("ready asset owned");
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("catalog reads are independent of optional analytics availability", async () => {
    const query: any = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      offset: async () => [{ id: "creative" }],
    };
    const db = { select: jest.fn(() => ({ from: () => query })) };
    const result = await new AdminHouseAdsController(
      db as any,
    ).listHouseCreatives();
    expect(result).toMatchObject({
      data: [{ id: "creative" }],
      analytics: null,
      meta: { page: 1, hasNext: false },
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
describe("PLAN0064 House issuance boundaries", () => {
  const params = {
    requestId: "request",
    slotTagId: "slot",
    slotId: null,
    websiteId: null,
    promoterId: "promoter",
    placementId: null,
    format: "banner",
    inventoryClass: "house",
    deliveryMode: "normal",
    trafficRiskStatus: "normal",
  };
  function fixture(catalog: any[]) {
    const writes: any[] = [];
    const query: any = {
      where: () => query,
      orderBy: () => query,
      for: async () => catalog,
    };
    const tx: any = {
      execute: jest.fn(async () => ({ rows: [] })),
      select: () => ({ from: () => query }),
      insert: (table: any) => ({
        values: (values: any) => {
          writes.push({ table, values });
          return { returning: async () => [{ id: "issued" }] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    };
    const token = {
      hashIp: () => "hash",
      generateToken: jest.fn(() => "signed"),
    };
    const evidence = { append: jest.fn(async () => ({})) };
    const service = new DeliveryService(
      { transaction: (cb: any) => cb(tx) } as any,
      token as any,
      { computeDecisionHash: () => "decision-hash" } as any,
      {} as any,
      undefined,
      evidence as any,
    );
    return { service, tx, writes, token, evidence };
  }
  it("returns no-fill without writes when catalog is empty or incompatible", async () => {
    for (const catalog of [
      [],
      [{ id: "wrong", format: "square", adType: "text" }],
    ]) {
      const f = fixture(catalog);
      expect(
        await (f.service as any).serveHouseOrShadowAd({ ...params }),
      ).toBeNull();
      expect(f.writes).toHaveLength(0);
      expect(f.evidence.append).not.toHaveBeenCalled();
    }
  });
  it("respects priority ordering and snapshots the selected zero-price creative destination", async () => {
    const f = fixture([
      {
        id: "text-priority",
        version: 2,
        format: "any",
        adType: "text",
        headline: "First",
        destinationUrl: "https://example.com/issued",
      },
      {
        id: "image-lower",
        version: 1,
        format: "banner",
        adType: "image",
        imageUrl: "https://example.com/ad.jpg",
      },
    ]);
    const ad = await (f.service as any).serveHouseOrShadowAd({ ...params });
    expect(ad.headline).toBe("First");
    expect(f.writes.find((w) => w.table === adsServes).values).toMatchObject({
      houseCreativeId: "text-priority",
      houseCreativeVersion: 2,
      houseDestinationUrl: "https://example.com/issued",
      billingPriceNanos: 0n,
      financialEligibility: "invalid",
      campaignId: null,
      creativeId: null,
    });
    expect(f.token.generateToken).toHaveBeenCalledWith(
      expect.objectContaining({ creativeId: "text-priority" }),
    );
  });
});
