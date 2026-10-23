import { Readable } from 'node:stream';
import { UploadsController } from '../../../api/ads-api/src/modules/uploads/uploads.controller';
import { UploadsService } from '../../../api/ads-api/src/modules/uploads/uploads.service';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { INestApplication, VersioningType } from '@nestjs/common';
import { DashboardAuthModule } from '../../../shared/src/security/access-token.guard';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { adsCorsOptions } from '../../../api/ads-api/src/modules/security/ads-cors';
import { ModerationController } from '../../../api/ads-api/src/modules/moderation/moderation.controller';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { AdsBillingController } from '../../../api/ads-api/src/modules/billing/ads-billing.controller';
import { AdsEscrowService } from '../../../api/ads-api/src/modules/billing/ads-escrow.service';
import { AdsSettlementService } from '../../../api/ads-api/src/modules/billing/ads-settlement.service';
import { DeferredAuditService } from '../../../api/ads-api/src/modules/billing/deferred-audit.service';
import { ConversionsController } from '../../../api/ads-api/src/modules/conversions/conversions.controller';
import { ConversionsService } from '../../../api/ads-api/src/modules/conversions/conversions.service';
import { DATABASE_TOKEN } from '../../../api/ads-api/src/modules/database/database.module';

const secret = 'test-only-ads-access-secret';
const id = 'e68f2fac-09d2-481b-85b2-896300cd169e';
const config = (raw: string) => ({ get: () => raw }) as any;
const moderation = { getQueue: jest.fn(async () => ({})), reviewCreative: jest.fn(), reviewCampaignPrimary: jest.fn(), reviewCampaignManager: jest.fn(), emergencyOverride: jest.fn(), reviewCampaign: jest.fn(), setPromoterSuspension: jest.fn() };
const escrow = { getBillingOverview: jest.fn(async (userId: string) => ({ userId })), getCampaignEscrow: jest.fn(async () => null), lockCampaignBudget: jest.fn(), releaseCampaignBudget: jest.fn() };
const settlement = { getHistoricalBatches: jest.fn(async () => []), processPendingSettlement: jest.fn(), settleFundedCampaign: jest.fn(async () => ({ status: 'completed' })) };
const conversions = { getPixelScript: jest.fn(() => '// pixel'), ingestConversion: jest.fn(), getConversions: jest.fn(async () => []) };
const uploads = { getMediaStream: jest.fn(async () => ({ stream: Readable.from('preview'), contentType: 'image/png', contentLength: 7 })) };
let status = 'ACTIVE';
const database = { query: { users: { findFirst: jest.fn(async () => ({ id, email: 'current@example.test', status })) } } };

describe('Ads staff grant configuration', () => {
  it('defaults to no permissions and validates every account and role', () => {
    expect(new AdsStaffGrants({ get: () => undefined } as any).rolesFor(id)).toEqual([]);
    for (const raw of ['[]', 'null', '{', '{"demo":["ads_admin"]}', JSON.stringify({ [id]: ['admin'] }), JSON.stringify({ [id]: 'ads_admin' })]) {
      expect(() => new AdsStaffGrants(config(raw))).toThrow();
    }
    expect(new AdsStaffGrants(config(JSON.stringify({ [id.toUpperCase()]: ['ads_reviewer', 'ads_reviewer'] }))).rolesFor(id)).toEqual(['ads_reviewer']);
  });
});

describe('Ads production guards and controllers over HTTP', () => {
  let app: INestApplication, base: string, grants: AdsStaffGrants;
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}, options: object = {}) => jwt.sign({ sub: id, email: 'old@example.test', type: 'access', ...claims }, { expiresIn: '5m', ...options });
  const headers = (claims: object = {}) => ({ Authorization: `Bearer ${token(claims)}`, 'Content-Type': 'application/json' });
  beforeAll(async () => {
    const previous = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = secret;
    let module;
    try {
      module = await Test.createTestingModule({
        imports: [DashboardAuthModule],
        controllers: [ModerationController, AdsBillingController, ConversionsController, UploadsController],
        providers: [
          { provide: DATABASE_TOKEN, useValue: database },
          { provide: ConfigService, useValue: { get: () => undefined } }, AdsStaffGrants,
          { provide: APP_GUARD, useClass: AdsAccessGuard },
          { provide: ModerationService, useValue: moderation }, { provide: AdsEscrowService, useValue: escrow },
          { provide: AdsSettlementService, useValue: settlement }, { provide: DeferredAuditService, useValue: {} },
          { provide: ConversionsService, useValue: conversions },
          { provide: UploadsService, useValue: uploads },
        ],
      }).compile();
    } finally { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; }
    grants = module.get(AdsStaffGrants);
    app = module.createNestApplication({ logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); app.setGlobalPrefix('api');
    app.enableCors(adsCorsOptions(undefined, true));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  beforeEach(() => { status = 'ACTIVE'; jest.clearAllMocks(); jest.restoreAllMocks(); });
  afterAll(async () => { await app?.close(); });

  it('rejects forged identity and valid-token staff claims without configured grants', async () => {
    expect((await fetch(`${base}/api/v1/ads/billing/overview`, { headers: { 'x-user-id': id } })).status).toBe(401);
    expect((await fetch(`${base}/api/v1/admin/ads/moderation/queue`, { headers: { ...headers({ roles: ['super_admin'], role: 'ads_admin' }), 'x-user-role': 'super_admin' } })).status).toBe(403);
    expect(moderation.getQueue).not.toHaveBeenCalled();
  });

  it('allows an owner API without staff grants and passes only verified identity', async () => {
    const res = await fetch(`${base}/api/v1/ads/billing/overview`, { headers: { ...headers(), 'x-user-id': 'victim' } });
    expect(res.status).toBe(200); expect(escrow.getBillingOverview).toHaveBeenCalledWith(id);
    await fetch(`${base}/api/v1/ads/billing/escrow/campaign`, { headers: headers() });
    expect(escrow.getCampaignEscrow).toHaveBeenCalledWith('campaign', id);
  });

  it('only configured finance staff can dispatch a funded settlement', async () => {
    const body = JSON.stringify({ campaignId: id, requestId: id, periodEnd: '2026-01-01T00:00:00.000Z' });
    expect((await fetch(`${base}/api/v1/ads/billing/settlements/funded`, { method: 'POST', headers: headers(), body })).status).toBe(403);
    expect(settlement.settleFundedCampaign).not.toHaveBeenCalled();
    jest.spyOn(grants, 'rolesFor').mockReturnValue(['ads_finance']);
    expect((await fetch(`${base}/api/v1/ads/billing/settlements/funded`, { method: 'POST', headers: headers(), body })).status).toBe(201);
    expect(settlement.settleFundedCampaign).toHaveBeenCalledWith(id, id, '2026-01-01T00:00:00.000Z');
  });

  it('rejects MFA, expired, wrong-key tokens and suspended/deleted accounts before service calls', async () => {
    for (const bad of [token({ type: 'mfa_challenge' }), token({}, { expiresIn: -1 }), new JwtService({ secret: 'wrong' }).sign({ sub: id })]) {
      expect((await fetch(`${base}/api/v1/ads/billing/overview`, { headers: { Authorization: `Bearer ${bad}` } })).status).toBe(401);
    }
    for (status of ['SUSPENDED', 'DELETED']) expect((await fetch(`${base}/api/v1/ads/billing/overview`, { headers: headers() })).status).toBe(401);
    expect(escrow.getBillingOverview).not.toHaveBeenCalled();
  });

  it.each([
    ['ads_support', 'creatives/c/decision', 403], ['ads_reviewer', 'creatives/c/decision', 201],
    ['ads_reviewer', 'campaigns/c/manager-approval', 403], ['ads_manager', 'campaigns/c/manager-approval', 201],
    ['ads_manager', 'campaigns/c/primary-review', 403], ['ads_finance', 'campaigns/c/primary-review', 403],
    ['ads_admin', 'campaigns/c/emergency-override', 403], ['super_admin', 'campaigns/c/emergency-override', 201],
    ['super_admin', 'campaigns/c/primary-review', 403], ['ads_support', 'promoters/p/suspend', 403],
    ['ads_admin', 'promoters/p/suspend', 201],
  ])('enforces %s on %s', async (role, route, expected) => {
    jest.spyOn(grants, 'rolesFor').mockReturnValue([role as any]);
    const res = await fetch(`${base}/api/v1/admin/ads/moderation/${route}`, { method: 'POST', headers: headers(), body: '{}' });
    expect(res.status).toBe(expected);
  });

  it('keeps support read-only and finance isolated from moderation', async () => {
    jest.spyOn(grants, 'rolesFor').mockReturnValue(['ads_support']);
    expect((await fetch(`${base}/api/v1/admin/ads/moderation/queue`, { headers: headers() })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/ads/billing/settlements`, { headers: headers() })).status).toBe(403);
    jest.spyOn(grants, 'rolesFor').mockReturnValue(['ads_finance']);
    expect((await fetch(`${base}/api/v1/ads/billing/settlements`, { headers: headers() })).status).toBe(200);
  });

  it('keeps pixel script public and conversion listing private at their correct versioned routes', async () => {
    expect((await fetch(`${base}/api/v1/px.js`)).status).toBe(200);
    expect((await fetch(`${base}/api/v1/conversions`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/conversions`, { headers: headers() })).status).toBe(200);
    expect(conversions.getConversions).toHaveBeenCalledWith(id, expect.anything());
  });

  it('requires staff grants for review media, owner identity for private preview and never publicly bypasses approval', async () => {
    const preview = `${base}/api/v1/uploads/review-media/file`;
    expect((await fetch(preview)).status).toBe(401);
    expect((await fetch(preview, { headers: headers() })).status).toBe(403);
    jest.spyOn(grants, 'rolesFor').mockReturnValue(['ads_finance']);
    expect((await fetch(preview, { headers: headers() })).status).toBe(403);
    expect(uploads.getMediaStream).not.toHaveBeenCalled();
    jest.spyOn(grants, 'rolesFor').mockReturnValue(['ads_reviewer']);
    const res = await fetch(preview, { headers: headers() });
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('preview');
    expect(uploads.getMediaStream).toHaveBeenCalledWith('file', undefined, true);
    await fetch(`${base}/api/v1/uploads/private-media/file`, { headers: headers() });
    expect(uploads.getMediaStream).toHaveBeenCalledWith('file', id);
    await fetch(`${base}/api/v1/uploads/media/file?staffReview=true`);
    expect(uploads.getMediaStream).toHaveBeenLastCalledWith('file');
  });

  it('uses wildcard cookie-free CORS only for public paths', async () => {
    const preflight = async (path: string, origin: string) => fetch(`${base}${path}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
    const publicRes = await preflight('/api/v1/px.js', 'https://publisher.example');
    expect(publicRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(publicRes.headers.get('access-control-allow-credentials')).toBeNull();
    const rejected = await preflight('/api/v1/ads/billing/overview', 'https://publisher.example');
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await preflight('/api/v1/ads/billing/overview', 'https://ads.crimfig.com');
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ads.crimfig.com');
  });
});
