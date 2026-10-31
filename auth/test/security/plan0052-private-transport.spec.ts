import { generateKeyPairSync } from 'crypto';
import { signPrivateRequest, verifyPrivateRequest, signPrivateResponse, readPrivateResponse } from '../../../shared/src/financial-security/private-transport';
describe('PLAN-0052 private authority transport binding', () => {
  const pair = generateKeyPairSync('ed25519'), now = 1800000000000;
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keys = { key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const request = () => signPrivateRequest('/internal/v1/withdrawals/execute', { reference: 'reference' }, 'key', privateKey, now);
  test('altered body, route, key or timestamp cannot authenticate', () => {
    for (const change of [{ body: '{}' }, { path: '/internal/v1/withdrawals/authorize' }, { keyId: 'other' }, { timestamp: now - 30001 }])
      expect(verifyPrivateRequest({ ...request(), ...change }, keys, now)).toBe(false);
  });
  test('a valid response cannot be reused for another request or changed after signing', () => {
    const req = request(), res = signPrivateResponse(req, { state: 'submitted' }, 'key', privateKey, now);
    expect(() => readPrivateResponse(res, request(), keys, now)).toThrow();
    expect(() => readPrivateResponse({ ...res, body: '{"state":"completed"}' }, req, keys, now)).toThrow();
    expect(() => readPrivateResponse(res, req, keys, now + 30001)).toThrow();
  });
  test('authenticates exact request and its nonce-bound response', () => {
    const req = request(); expect(verifyPrivateRequest(req, keys, now)).toBe(true);
    expect(readPrivateResponse(signPrivateResponse(req, { state: 'held' }, 'key', privateKey, now), req, keys, now)).toEqual({ state: 'held' });
  });
});
