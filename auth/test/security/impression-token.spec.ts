import { createHmac } from 'crypto';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';

const key = 'test-only-impression-key-32-characters-minimum';
const id = '11111111-1111-4111-8111-111111111111';
const original = process.env.ADS_IMPRESSION_SIGNING_KEY;
const payload = { servedId: id, placementId: id, campaignId: id, creativeId: id, promoterId: id, ipHash: 'unknown' };
function signed(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `imp_${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
beforeEach(() => { process.env.ADS_IMPRESSION_SIGNING_KEY = key; });
afterAll(() => { if (original === undefined) delete process.env.ADS_IMPRESSION_SIGNING_KEY; else process.env.ADS_IMPRESSION_SIGNING_KEY = original; });

test.each([undefined, '', 'short', 'crimfig_default_ads_sec_key_2026'])('missing/weak signing config fails closed: %s', value => {
  if (value === undefined) delete process.env.ADS_IMPRESSION_SIGNING_KEY; else process.env.ADS_IMPRESSION_SIGNING_KEY = value;
  const service = new ImpressionTokenService();
  expect(() => service.generateToken(payload)).toThrow('not configured');
  expect(service.verifyToken(signed({ ...payload, version: 2, timestamp: Date.now() }))).toBeNull();
});
test('token binds IP including missing-IP mismatch', () => {
  const service = new ImpressionTokenService();
  const token = service.generateToken({ ...payload, ipHash: service.hashIp('127.0.0.1') });
  expect(service.verifyToken(token, '127.0.0.1')?.version).toBe(2);
  expect(service.verifyToken(token)).toBeNull();
  expect(service.verifyToken(token, '127.0.0.2')).toBeNull();
});
test.each(['imp_x.a', 'imp_x.' + 'x'.repeat(44), 'imp_x.' + 'x'.repeat(43), 'imp_' + 'x'.repeat(3000), 'legacy'])('malformed token rejected without throwing (case %#)', token => {
  expect(new ImpressionTokenService().verifyToken(token)).toBeNull();
});
test.each([
  { version: 1 }, { timestamp: Date.now() + 60_000 }, { timestamp: Date.now() - 901_000 },
  { timestamp: 'now' }, { servedId: 'invented' }, { promoterId: undefined }, { ipHash: '' },
])('signed invalid payload rejected: %j', change => {
  expect(new ImpressionTokenService().verifyToken(signed({ ...payload, version: 2, timestamp: Date.now(), ...change }))).toBeNull();
});
test('tampered payload rejected', () => {
  const service = new ImpressionTokenService();
  expect(service.verifyToken(service.generateToken(payload).replace('imp_', 'imp_a'))).toBeNull();
});
test('invalid signed claims cannot downgrade to legacy or write telemetry', async () => {
  const db = { select: jest.fn(), insert: jest.fn() };
  const delivery = new DeliveryService(db as any, new ImpressionTokenService(), {} as any, {} as any);
  await delivery.logInteraction({ impToken: 'imp_bad.a', placementToken: 'legacy', type: 'click' });
  await expect(delivery.handleClick('imp_bad.a')).rejects.toThrow('invalid or expired');
  expect(db.select).not.toHaveBeenCalled();
  expect(db.insert).not.toHaveBeenCalled();
});
test('signed identities must match stored serve', async () => {
  const service = new ImpressionTokenService();
  const token = service.generateToken(payload);
  const query: any = { from: () => query, where: () => query, limit: async () => [{
    ...payload, id, servedAt: new Date(), campaignId: '22222222-2222-4222-8222-222222222222',
  }] };
  const db = { select: () => query, insert: jest.fn() };
  const delivery = new DeliveryService(db as any, service, {} as any, {} as any);
  await expect(delivery.handleClick(token)).rejects.toThrow('does not match');
  await delivery.logInteraction({ impToken: token, type: 'impression' });
  expect(db.insert).not.toHaveBeenCalled();
});


test('SDK attestation and rewards cannot manufacture verified success', async () => {
  const { DeliveryController } = await import('../../../api/ads-api/src/modules/delivery/delivery.controller');
  const controller = new DeliveryController({} as any);
  expect(() => controller.createAppSession({ attestationToken: 'x'.repeat(100) })).toThrow('provider verification');
  expect(() => controller.verifyReward({ userId: id })).toThrow('funded reward eligibility');
  expect(() => controller.getSdkConfig('unregistered')).toThrow('unavailable');
});
test('delivery ignores untrusted forwarded IP and forwards signed interaction token', async () => {
  const { DeliveryController } = await import('../../../api/ads-api/src/modules/delivery/delivery.controller');
  const logInteraction = jest.fn();
  const controller = new DeliveryController({ logInteraction } as any);
  await controller.trackInteraction({ impToken: 'signed', type: 'click' }, {
    ip: '127.0.0.1', headers: { 'x-forwarded-for': 'attacker-value' }, socket: {},
  } as any);
  expect(logInteraction).toHaveBeenCalledWith(expect.objectContaining({ impToken: 'signed', clientIp: '127.0.0.1' }));
});
test('delivery DTOs validate payloads and reject unsupported telemetry', async () => {
  const { validate } = await import('class-validator');
  const { TrackInteractionDto, ViewabilityTelemetryDto } = await import('../../../api/ads-api/src/modules/delivery/delivery.controller');
  const dto = Object.assign(new TrackInteractionDto(), { impToken: 'signed', type: 'click', source: 'embed' });
  expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  dto.type = 'cash_credit' as any;
  expect((await validate(dto)).length).toBeGreaterThan(0);
  const view = Object.assign(new ViewabilityTelemetryDto(), { impToken: 'signed', visibleRatio: 2, durationSeconds: -1 });
  expect(await validate(view)).toHaveLength(2);
});
