import { generateKeyPairSync } from 'crypto';
import { FinancialPrivateApi } from '../../../shared/src/financial-security/private-api';
import { readPrivateResponse, signPrivateRequest } from '../../../shared/src/financial-security/private-transport';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
import { withdrawalDigest } from '../../../shared/src/financial-security/authorization';

describe('PLAN-0052 isolated private API', () => {
  const pair = generateKeyPairSync('ed25519');
  const secret = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  function setup() {
    const binding = { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: 'owner', ownerPersonId: 'person', destinationKey: 'bank', destinationVersion: 'v1', recipientCode: 'RCP_1', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test' as const, policyVersion: policy.version, expiresAt: Date.now() + 60000 };
    const store = { consumeWorkloadNonce: jest.fn().mockResolvedValue(undefined), prepare: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(async work => work({ load: async () => ({ binding, state: 'pending' }) })) };
    const quotes = { binding: jest.fn().mockResolvedValue(binding), reservationMatches: jest.fn().mockResolvedValue(true) };
    const executor = { execute: jest.fn().mockResolvedValue({ reference: binding.reference, state: 'held' }) };
    return { binding, store, quotes, executor, api: new FinancialPrivateApi(store as any, quotes, executor as any, { billing: { publicKey, role: 'billing' }, auth: { publicKey, role: 'auth' } }, {}, 'authority', secret) };
  }
  test('forged workload cannot query facts, write intents or execute', async () => {
    const s = setup(), path = '/internal/v1/withdrawals/prepare'; const req = signPrivateRequest(path, {}, 'billing', secret); req.body = '{"forged":true}';
    await expect(s.api.handle(path, req)).rejects.toThrow('authentication'); expect(s.store.consumeWorkloadNonce).not.toHaveBeenCalled(); expect(s.quotes.binding).not.toHaveBeenCalled(); expect(s.executor.execute).not.toHaveBeenCalled();
  });
  test('Auth workload cannot execute transfers', async () => {
    const s = setup(), path = '/internal/v1/withdrawals/execute';
    await expect(s.api.handle(path, signPrivateRequest(path, {}, 'auth', secret))).rejects.toThrow('scope'); expect(s.executor.execute).not.toHaveBeenCalled();
  });
  test('replayed workload nonce cannot prepare another intent', async () => {
    const s = setup(), path = '/internal/v1/withdrawals/prepare'; s.store.consumeWorkloadNonce.mockRejectedValue(new Error('duplicate nonce'));
    await expect(s.api.handle(path, signPrivateRequest(path, {}, 'billing', secret))).rejects.toThrow(); expect(s.store.prepare).not.toHaveBeenCalled();
  });
  test('missing actual ledger reservation prevents execution despite valid transport', async () => {
    const s = setup(), path = '/internal/v1/withdrawals/execute'; s.quotes.reservationMatches.mockResolvedValue(false);
    const req = signPrivateRequest(path, { reference: s.binding.reference, userId: 'owner', digest: withdrawalDigest(s.binding), amountKobo: s.binding.amountKobo, recipientCode: s.binding.recipientCode, domain: 'test' }, 'billing', secret);
    await expect(s.api.handle(path, req)).rejects.toThrow('reservation'); expect(s.executor.execute).not.toHaveBeenCalled();
  });
  test('prepare derives the binding from the independent read source and signs its response', async () => {
    const s = setup(), path = '/internal/v1/withdrawals/prepare', req = signPrivateRequest(path, { userId: 'owner' }, 'billing', secret);
    const response = await s.api.handle(path, req);
    expect(s.store.prepare).toHaveBeenCalledWith(s.binding);
    expect(readPrivateResponse(response, req, { authority: publicKey })).toMatchObject({ reference: s.binding.reference, state: 'awaiting_authorization' });
    expect(s.executor.execute).not.toHaveBeenCalled();
  });
});
