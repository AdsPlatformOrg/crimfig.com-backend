import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
import { AdsEscrowService } from '../../../api/ads-api/src/modules/billing/ads-escrow.service';
import { DisputesService } from '../../../api/ads-api/src/modules/disputes/disputes.service';
import { PlacementsService } from '../../../api/ads-api/src/modules/placements/placements.service';
import { UploadsService } from '../../../api/ads-api/src/modules/uploads/uploads.service';
import { ConversionsService } from '../../../api/ads-api/src/modules/conversions/conversions.service';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';

/** Isolated query adapter records Drizzle predicates; no real database is contacted. */
function database(rows: any[][]) {
  const predicates: any[] = [], dialect = new PgDialect();
  const db: any = {
    select: jest.fn(() => {
      const result = rows.shift() || [];
      const chain: any = {
        from: () => chain, innerJoin: () => chain, orderBy: () => chain,
        where: (where: any) => { predicates.push(dialect.sqlToQuery(where)); return chain; },
        limit: async () => result,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    }),
    insert: jest.fn(() => ({ values: jest.fn((value: any) => ({ returning: async () => [{ id: 'record', ...value }] })) })),
    update: jest.fn(),
  };
  return { db, predicates };
}

describe('Ads object ownership and workflow boundaries', () => {
  it('campaign detail always queries the authenticated owner before creatives', async () => {
    const { db, predicates } = database([[]]);
    await expect(new CampaignsService(db, {} as any).getCampaignDetails('campaign', 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    expect(predicates[0].params).toEqual(expect.arrayContaining(['campaign', 'intruder']));
    expect(db.select).toHaveBeenCalledTimes(1);
    await expect(new CampaignsService(db, {} as any).getCampaignDetails('campaign', '')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('escrow read and lock enforce campaign ownership before Billing calls', async () => {
    const { db, predicates } = database([[], []]);
    const billing = { getWalletBalance: jest.fn(), lockFunds: jest.fn() };
    const service = new AdsEscrowService(db, billing as any);
    await expect(service.lockCampaignBudget({ campaignId: 'campaign', userId: 'intruder', amountUsdCents: 500 })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getCampaignEscrow('campaign', 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    for (const predicate of predicates) expect(predicate.params).toEqual(expect.arrayContaining(['campaign', 'intruder']));
    expect(billing.getWalletBalance).not.toHaveBeenCalled(); expect(billing.lockFunds).not.toHaveBeenCalled();
  });

  it('does not allow owner status changes to bypass moderation or staff suspension', async () => {
    for (const [status, campaign] of [
      ['active', { status: 'paused', moderationStatus: 'pending_primary_review' }],
      ['paused', { status: 'suspended', moderationStatus: 'approved' }],
      ['rejected', { status: 'paused', moderationStatus: 'approved' }],
    ] as const) {
      const { db } = database([[campaign]]);
      await expect(new CampaignsService(db, {} as any).updateStatus('campaign', 'owner', status)).rejects.toBeInstanceOf(BadRequestException);
      expect(db.update).not.toHaveBeenCalled();
    }
  });

  it('does not activate an approved campaign if funding fails', async () => {
    const { db } = database([[{ id: 'campaign', status: 'paused', moderationStatus: 'approved', remainingBudgetUsdCents: 500 }]]);
    const escrow = { changeCampaignStatus: jest.fn(async () => { throw new Error('Billing unavailable'); }) };
    await expect(new CampaignsService(db, escrow as any).updateStatus('campaign', 'owner', 'active')).rejects.toThrow('Billing unavailable');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('dispute read includes owner and creation rejects foreign campaign before insert', async () => {
    const { db, predicates } = database([[], []]);
    const service = new DisputesService(db);
    await expect(service.getDisputeById('dispute', 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createDispute({ openedBy: 'intruder', role: 'advertiser', scope: 'campaign', campaignId: 'campaign', periodFrom: '2026-10-01', periodTo: '2026-10-02', reason: 'quality', details: 'details' })).rejects.toBeInstanceOf(NotFoundException);
    expect(predicates[0].params).toEqual(expect.arrayContaining(['dispute', 'intruder']));
    expect(predicates[1].params).toEqual(expect.arrayContaining(['campaign', 'intruder']));
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('placement creation checks site ownership and campaign creative binding before insert', async () => {
    const promoter = { id: 'promoter', isActive: true, isSuspended: false };
    const foreignSite = database([[promoter], []]);
    await expect(new PlacementsService(foreignSite.db).createPlacement({ promoterId: 'promoter', campaignId: 'campaign', websiteId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);
    expect(foreignSite.predicates[1].params).toEqual(expect.arrayContaining(['foreign', 'promoter']));
    expect(foreignSite.db.insert).not.toHaveBeenCalled();
    const wrongCreative = database([[promoter], [{ id: 'campaign' }], []]);
    await expect(new PlacementsService(wrongCreative.db).createPlacement({ promoterId: 'promoter', campaignId: 'campaign', creativeId: 'foreign' })).rejects.toBeInstanceOf(BadRequestException);
    expect(wrongCreative.predicates[2].params).toEqual(expect.arrayContaining(['foreign', 'campaign', 'active', 'approved']));
    expect(wrongCreative.db.insert).not.toHaveBeenCalled();
  });

  it('private media requires an owner match and public media requires approved active binding before bucket access', async () => {
    const bucket = { getBucket: jest.fn() };
    const owner = database([[]]);
    await expect(new UploadsService(owner.db, {} as any, bucket as any).getMediaStream('file-key', 'intruder')).rejects.toBeInstanceOf(NotFoundException);
    expect(owner.predicates[0].params).toEqual(expect.arrayContaining(['file-key', 'intruder', 'ready']));
    const publicAsset = database([[{ ownerId: 'owner', cdnUrl: '/api/v1/uploads/media/file-key' }], []]);
    await expect(new UploadsService(publicAsset.db, {} as any, bucket as any).getMediaStream('file-key')).rejects.toBeInstanceOf(NotFoundException);
    expect(publicAsset.predicates[1].params).toEqual(expect.arrayContaining(['owner', 'active', 'approved', '/api/v1/uploads/media/file-key']));
    expect(bucket.getBucket).not.toHaveBeenCalled();
  });

  it('manager approval and emergency override never bypass funded activation', async () => {
    for (const method of ['reviewCampaignManager', 'emergencyOverride'] as const) {
      const { db } = database([[{ id: 'campaign', advertiserId: 'owner', moderationStatus: 'pending_manager_approval', status: 'under_review' }], [{ reviewerId: 'primary-reviewer' }]]);
      const values: any[] = [];
      db.update = () => ({ set: (value: any) => { values.push(value); return { where: () => ({ returning: async () => [{ id: 'campaign', ...value }] }) }; } });
      const result = await new ModerationService(db)[method]('campaign', { reviewerId: 'manager', decision: 'approved', overrideReason: 'Documented emergency fixture reason' });
      expect(values.at(-1)).toMatchObject({ status: 'paused', moderationStatus: 'approved' });
      expect(result.live).toBe(false);
    }
  });

  it('prevents staff owners from reviewing their own campaign or creative', async () => {
    for (const method of ['reviewCampaignPrimary', 'reviewCampaignManager'] as const) {
      const { db } = database([[{ advertiserId: 'owner' }]]);
      await expect(new ModerationService(db)[method]('campaign', { reviewerId: 'owner', decision: 'approved' })).rejects.toBeInstanceOf(BadRequestException);
      expect(db.insert).not.toHaveBeenCalled();
    }
    const { db } = database([[{ campaignId: 'campaign' }], [{ advertiserId: 'owner' }]]);
    await expect(new ModerationService(db).reviewCreative('creative', { reviewerId: 'owner', decision: 'approved' })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('Public conversion telemetry cannot replace server authentication', () => {
  it('requires an API key for S2S even if an advertiser ID was supplied', async () => {
    const { db } = database([]);
    await expect(new ConversionsService(db).ingestConversion({ source: 's2s', advertiserId: 'victim', event: 'purchase' })).rejects.toThrow('API key');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('stores browser beacons without payable attribution or authoritative order dedupe keys', async () => {
    const { db } = database([]);
    const result = await new ConversionsService(db).ingestConversion({ source: 'pixel', advertiserId: 'owner', clickId: 'forged-click', orderId: 'real-order', event: 'purchase' });
    expect(result).toBeDefined();
    const payload = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(payload).toMatchObject({ source: 'pixel', status: 'unattributed', orderId: null, attributedPromoterId: null });
    expect(payload.campaignId).toBeUndefined(); expect(db.select).not.toHaveBeenCalled();
  });

  it('cannot attribute a valid click from a different advertiser campaign', async () => {
    const { db, predicates } = database([[{ campaignId: 'foreign-campaign', promoterId: 'promoter' }], []]);
    const service = new ConversionsService(db);
    jest.spyOn(service, 'verifyApiKey').mockResolvedValue({ advertiserId: 'owner' } as any);
    await service.ingestConversion({ source: 's2s', apiKey: 'cf_adv_test', clickId: 'click', event: 'purchase' });
    expect(predicates[1].params).toEqual(expect.arrayContaining(['foreign-campaign', 'owner']));
    const payload = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(payload).toMatchObject({ status: 'unattributed', attributedPromoterId: null });
  });
});

 describe('Advertiser API key boundary', () => {
  it('rejects a stored key without conversion write scope', async () => {
    const { db } = database([[{ id: 'key', advertiserId: 'owner', scopes: 'reports:read' }]]);
    await expect(new ConversionsService(db).verifyApiKey('cf_adv_test')).rejects.toThrow('scope');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects a suspended key owner before conversion or key-use writes', async () => {
    const { db } = database([[{ id: 'key', advertiserId: 'owner', scopes: 'conversions:write' }]]);
    db.query = { users: { findFirst: jest.fn(async () => ({ status: 'SUSPENDED' })) } };
    await expect(new ConversionsService(db).verifyApiKey('cf_adv_test')).rejects.toThrow('not available');
    expect(db.update).not.toHaveBeenCalled(); expect(db.insert).not.toHaveBeenCalled();
  });

  it('attributes an authenticated S2S conversion only to its own campaign', async () => {
    const { db } = database([[{ campaignId: 'campaign', promoterId: 'promoter' }], [{ id: 'campaign', advertiserId: 'owner' }]]);
    const service = new ConversionsService(db);
    jest.spyOn(service, 'verifyApiKey').mockResolvedValue({ advertiserId: 'owner' } as any);
    await service.ingestConversion({ source: 's2s', apiKey: 'cf_adv_test', advertiserId: 'ignored-victim', clickId: 'click', event: 'purchase' });
    const payload = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(payload).toMatchObject({ advertiserId: 'owner', campaignId: 'campaign', status: 'attributed', attributedPromoterId: 'promoter' });
  });
 });


describe('Conversion currency and value integrity', () => {
  it.each([[0, 'USD', 0, 0], [12.5, 'NGN', 12500000, null], [2, 'usd', 2000000, 2000000], [undefined, 'USD', null, null]])('preserves value %s in %s without invented FX', async (value, currency, micros, usd) => {
    const { db } = database([]);
    await new ConversionsService(db).ingestConversion({ source: 'pixel', advertiserId: 'owner', event: 'purchase', value, currency });
    const payload = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(payload.valueMicros).toBe(micros); expect(payload.valueUsdMicros).toBe(usd);
    expect(payload.currency).toBe(currency.toUpperCase());
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects unsafe value %s before insert', async value => {
    const { db } = database([]);
    await expect(new ConversionsService(db).ingestConversion({ source: 'pixel', advertiserId: 'owner', event: 'purchase', value })).rejects.toThrow('value');
    expect(db.insert).not.toHaveBeenCalled();
  });
});
