import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { AdminHouseAdsController } from '../../../api/ads-api/src/modules/delivery/admin-house-ads.controller';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';

describe('PLAN-0163 House Preset Resolution & Dynamic Slot Matching', () => {
  const originalSigningKey = process.env.ADS_IMPRESSION_SIGNING_KEY;

  beforeEach(() => {
    process.env.ADS_IMPRESSION_SIGNING_KEY = 'plan0163-disposable-signing-key-32-bytes';
  });

  afterEach(() => {
    if (originalSigningKey === undefined) delete process.env.ADS_IMPRESSION_SIGNING_KEY;
    else process.env.ADS_IMPRESSION_SIGNING_KEY = originalSigningKey;
    jest.restoreAllMocks();
  });

  it('rejects unapproved targetPreset on create and update before DB writes', async () => {
    const existingRow = {
      id: randomUUID(),
      adType: 'image',
      imageUrl: 'https://ads.crimfig.com/uploads/media/house.png',
      videoUrl: null,
      targetPreset: 'medium_rectangle',
      renditionWidth: 300,
      renditionHeight: 250,
      width: 300,
      height: 250,
      version: 1,
    };
    const db: any = {
      select: jest.fn(() => ({
        from: () => ({ where: () => ({ limit: async () => [existingRow] }) }),
      })),
      insert: jest.fn(),
      update: jest.fn(),
    };
    const controller = new AdminHouseAdsController(db);

    await expect(
      controller.createHouseCreative(
        {
          title: 'Disabled text',
          adType: 'text',
          headline: 'H',
          bodyText: 'B',
        } as any,
        { user: { sub: randomUUID() } },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.createHouseCreative(
        {
          title: 'Disabled video',
          adType: 'video',
          videoUrl: 'https://ads.crimfig.com/uploads/media/v.mp4',
        } as any,
        { user: { sub: randomUUID() } },
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.createHouseCreative(
        {
          title: 'Bad preset',
          headline: 'H',
          bodyText: 'B',
          adType: 'image',
          imageUrl: 'https://ads.crimfig.com/uploads/media/house.png',
          targetPreset: 'invalid_preset',
        } as any,
        { user: { sub: randomUUID() } },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();

    await expect(
      controller.updateHouseCreative(
        existingRow.id,
        { targetPreset: 'invalid_preset' } as any,
        { user: { sub: randomUUID() } },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('re-resolves targetPreset and rendition dimensions when editing House creative dimensions', async () => {
    let insertedValues: any;
    let updatedValues: any;
    const existingRow = {
      id: randomUUID(),
      adType: 'image',
      imageUrl: 'https://ads.crimfig.com/uploads/media/house.png',
      videoUrl: null,
      targetPreset: 'medium_rectangle',
      renditionWidth: 300,
      renditionHeight: 250,
      width: 300,
      height: 250,
      version: 2,
    };

    const db: any = {
      select: jest.fn(() => ({
        from: () => ({ where: () => ({ limit: async () => [existingRow] }) }),
      })),
      insert: jest.fn(() => ({
        values: (vals: any) => {
          insertedValues = vals;
          return { returning: async () => [{ id: randomUUID(), ...vals }] };
        },
      })),
      update: jest.fn(() => ({
        set: (vals: any) => {
          updatedValues = vals;
          return { where: () => ({ returning: async () => [{ id: existingRow.id, ...vals }] }) };
        },
      })),
    };
    const controller = new AdminHouseAdsController(db);

    await controller.createHouseCreative(
      {
        title: 'Leaderboard',
        adType: 'image',
        imageUrl: 'https://ads.crimfig.com/uploads/media/house.png',
        width: 728,
        height: 90,
      } as any,
      { user: { sub: randomUUID() } },
    );
    expect(insertedValues).toMatchObject({
      headline: '',
      bodyText: '',
      ctaText: '',
      targetPreset: 'leaderboard',
      renditionWidth: 728,
      renditionHeight: 90,
      width: 728,
      height: 90,
    });

    // Simulate Admin UI spreading stale targetPreset='medium_rectangle' alongside new 728x90 dimensions
    await controller.updateHouseCreative(
      existingRow.id,
      {
        targetPreset: 'medium_rectangle',
        renditionWidth: 300,
        renditionHeight: 250,
        width: 728,
        height: 90,
        isActive: true,
      } as any,
      { user: { sub: randomUUID() } },
    );
    expect(updatedValues).toMatchObject({
      targetPreset: 'leaderboard',
      renditionWidth: 728,
      renditionHeight: 90,
      width: 728,
      height: 90,
      isActive: true,
    });

    // Editing to non-preset custom dimensions clears stale targetPreset instead of keeping mismatch
    await controller.updateHouseCreative(
      existingRow.id,
      {
        targetPreset: 'medium_rectangle',
        width: 410,
        height: 310,
      } as any,
      { user: { sub: randomUUID() } },
    );
    expect(updatedValues).toMatchObject({
      targetPreset: null,
      renditionWidth: 410,
      renditionHeight: 310,
      width: 410,
      height: 310,
    });
  });

  function buildDeliveryFixture(slotRow: Record<string, any>) {
    const creative = {
      id: randomUUID(),
      adType: 'image',
      format: 'banner',
      targetPreset: 'leaderboard',
      renditionWidth: 728,
      renditionHeight: 90,
      width: 728,
      height: 90,
      imageUrl: 'https://ads.crimfig.com/uploads/media/leaderboard.png',
      videoUrl: null,
      posterUrl: null,
      headline: 'Promote on CrimFig',
      bodyText: 'Reach verified audiences.',
      ctaText: 'Start Advertising',
      destinationUrl: 'https://ads.crimfig.com',
      version: 1,
      isActive: true,
      isArchived: false,
      priority: 10,
    };
    const slotId = randomUUID();
    const websiteId = randomUUID();
    const promoterId = randomUUID();
    const userId = randomUUID();
    const decisionId = randomUUID();
    const serveId = randomUUID();

    let selectCount = 0;
    const tx: any = {
      execute: jest.fn(async (query: any) => {
        const text = query?.queryChunks ? JSON.stringify(query.queryChunks) : String(query);
        if (text.includes('program_feature_switches')) return { rows: [{ enabled: false }] };
        return { rows: [] };
      }),
      select: jest.fn(() => {
        selectCount += 1;
        const callIndex = selectCount;
        const makeChain = (rows: any[]) => ({
          from: () => makeChain(rows),
          innerJoin: () => makeChain(rows),
          where: () => makeChain(rows),
          orderBy: () => makeChain(rows),
          for: () => (callIndex === 1 ? Promise.resolve(rows) : makeChain(rows)),
          limit: async () => rows,
        });
        if (callIndex === 1) return makeChain([creative]);
        if (callIndex === 2) return makeChain([slotRow]);
        if (callIndex === 3) {
          return makeChain([
            {
              slot: { id: slotId, policyRevision: 1, isActive: true, lifecycleStatus: 'active' },
              site: {
                id: websiteId,
                promoterId,
                policyStatus: 'approved',
                policyRevision: 1,
                verificationStatus: 'verified',
                verificationExpiresAt: new Date(Date.now() + 86_400_000),
                isActive: true,
                isSuspended: false,
              },
              promoter: { id: promoterId, userId, isActive: true, isSuspended: false },
            },
          ]);
        }
        return makeChain([{ status: 'ACTIVE' }]);
      }),
      insert: jest.fn(() => ({
        values: () => ({
          returning: async () => [{ id: tx.insert.mock.calls.length === 1 ? decisionId : serveId }],
        }),
      })),
      update: jest.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    };

    const db: any = {
      transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(tx)),
    };
    const tokens = new ImpressionTokenService();
    const auctionEngine: any = { computeDecisionHash: jest.fn(() => 'hash-1') };
    const evidence: any = { append: jest.fn(async () => undefined) };
    const delivery = new DeliveryService(db, tokens, auctionEngine, {} as any, undefined, evidence);

    return { delivery, tx, slotId, websiteId, promoterId };
  }

  it('rejects malformed or mismatched slot restrictions before serving or writing auction records', async () => {
    for (const badSlot of [
      { presetPolicy: 'selected', allowedPresetIds: 'invalid', width: null, height: null, allowedAdTypes: '["image"]' },
      { presetPolicy: 'selected', allowedPresetIds: '["square"]', width: null, height: null, allowedAdTypes: '["image"]' },
      { presetPolicy: 'auto_any_approved', allowedPresetIds: null, width: 500, height: null, allowedAdTypes: '["image"]' },
    ]) {
      const f = buildDeliveryFixture(badSlot);
      const res = await (f.delivery as any).serveHouseOrShadowAd({
        requestId: randomUUID(),
        containerWidth: 900,
        slotTagId: 'cf-slot-network-test',
        slotId: f.slotId,
        websiteId: f.websiteId,
        promoterId: f.promoterId,
        placementId: null,
        format: 'general',
        inventoryClass: 'house',
        deliveryMode: 'normal',
        trafficRiskStatus: 'normal',
        clientIp: '192.0.2.1',
      });
      expect(res).toBeNull();
      expect(f.tx.insert).not.toHaveBeenCalled();
    }
  });

  it('treats empty JSON array allowedPresetIds ("[]") on dynamic general slots as eligible for matching House Ads', async () => {
    const f = buildDeliveryFixture({
      presetPolicy: 'auto_any_approved',
      allowedPresetIds: '[]',
      width: null,
      height: null,
      allowedAdTypes: '["image"]',
    });

    const res = await (f.delivery as any).serveHouseOrShadowAd({
      requestId: randomUUID(),
      containerWidth: 900,
      slotTagId: 'cf-slot-network-test',
      slotId: f.slotId,
      websiteId: f.websiteId,
      promoterId: f.promoterId,
      placementId: null,
      format: 'general',
      inventoryClass: 'house',
      deliveryMode: 'normal',
      trafficRiskStatus: 'normal',
      clientIp: '192.0.2.1',
    });

    expect(res).not.toBeNull();
    expect(res.adType).toBe('image');
    expect(res.width).toBe(728);
    expect(res.height).toBe(90);
    expect(f.tx.insert).toHaveBeenCalledTimes(2);
  });
});
