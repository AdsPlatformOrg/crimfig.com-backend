jest.mock('../../../shared/src/financial-security/policy.config', () => {
  const actual = jest.requireActual('../../../shared/src/financial-security/policy.config');
  return { FINANCIAL_SECURITY_POLICY: { ...actual.FINANCIAL_SECURITY_POLICY, executionEnabled: true } };
});
import { generateKeyPairSync, sign } from 'crypto';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
import { FinancialProof, proofMessage, WithdrawalBinding, withdrawalDigest } from '../../../shared/src/financial-security/authorization';
import { IndependentWithdrawalExecutor } from '../../../shared/src/financial-security/executor';

describe('PLAN-0052 executor side-effect boundaries (test-only release policy)', () => {
  const now = 1_800_000_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { auth: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const binding: WithdrawalBinding = { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: 'owner', ownerPersonId: 'owner-person',
    destinationKey: 'canonical-bank-account', destinationVersion: 'v1', recipientCode: 'recipient', amountUsdCents: 5000, amountKobo: 500_000, feeKobo: 5000,
    exchangeRateId: 'rate', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60_000 };
  function proof(actorId: string, purpose: FinancialProof['purpose']): FinancialProof {
    const p: FinancialProof = { version: 1, keyId: 'auth', purpose, audience: 'financial-executor', environment: 'test',
      digest: withdrawalDigest(binding), actorId, personId: `${actorId}-person`, nonce: actorId, issuedAt: now, expiresAt: now + 60_000, signature: '' };
    p.signature = sign(null, proofMessage(p), privateKey).toString('base64url'); return p;
  }
  function setup() {
    const record = { binding, ownerProof: proof('owner', 'owner_authorization'), reviews: [proof('reviewer', 'independent_review')], state: 'pending' };
    const tx = { load: jest.fn().mockResolvedValue(record), assess: jest.fn().mockResolvedValue({ observedAt: now, digest: withdrawalDigest(binding),
      risk: 'standard', clearedFundsVerified: true, frozen: false, protectionHealthy: true, destinationVerifiedAt: now - policy.destinationCooldownMs,
      lastAccountRecoveryAt: null, ownerDayUsdCents: 0, destinationDayUsdCents: 0, platformHourUsdCents: 0, platformDayUsdCents: 0, outstandingUsdCents: 0, hotFloatUsdCents: 50_000 }),
      reviewKeys: jest.fn().mockResolvedValue(keys), platformAdmins: jest.fn().mockResolvedValue(new Map([['reviewer', 'reviewer-person']])), consumedNonces: jest.fn().mockResolvedValue(new Set()),
      claim: jest.fn().mockResolvedValue(undefined), audit: jest.fn().mockResolvedValue(undefined) };
    const store = { transaction: jest.fn(async work => work(tx)), recordSubmission: jest.fn().mockResolvedValue(undefined), recordUnknown: jest.fn().mockResolvedValue(undefined) };
    const adapter = { submit: jest.fn().mockResolvedValue({ reference: binding.reference, digest: withdrawalDigest(binding), receipt: 'provider-receipt' }) };
    const readiness = { independentlyVerified: jest.fn().mockResolvedValue(true) };
    return { tx, store, adapter, readiness, record, executor: new IndependentWithdrawalExecutor(store, adapter, readiness, keys, () => now) };
  }
  test('invalid references cannot touch authority or provider', async () => {
    const s = setup(); await expect(s.executor.execute('invalid')).rejects.toThrow();
    expect(s.store.transaction).not.toHaveBeenCalled(); expect(s.adapter.submit).not.toHaveBeenCalled();
  });
  test('missing independent readiness holds without reservations or provider writes', async () => {
    const s = setup(); s.readiness.independentlyVerified.mockResolvedValue(false);
    expect(await s.executor.execute(binding.reference)).toMatchObject({ state: 'held' });
    expect(s.store.transaction).not.toHaveBeenCalled(); expect(s.adapter.submit).not.toHaveBeenCalled();
  });
  test.each(['owner-proof', 'reviewer', 'replay', 'risk', 'already-started'])('blocks %s before claim/provider side effects', async kind => {
    const s = setup();
    if (kind === 'owner-proof') s.record.ownerProof.signature = 'A'.repeat(86);
    if (kind === 'reviewer') s.tx.platformAdmins.mockResolvedValue(new Map());
    if (kind === 'replay') s.tx.consumedNonces.mockResolvedValue(new Set(['owner']));
    if (kind === 'risk') s.tx.assess.mockResolvedValue({});
    if (kind === 'already-started') s.record.state = 'started';
    expect((await s.executor.execute(binding.reference)).state).toBe(kind === 'already-started' ? 'recovery_required' : 'held');
    expect(s.tx.claim).not.toHaveBeenCalled(); expect(s.adapter.submit).not.toHaveBeenCalled();
  });
  test('transaction failure never calls provider', async () => {
    const s = setup(); s.tx.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(s.executor.execute(binding.reference)).rejects.toThrow(); expect(s.adapter.submit).not.toHaveBeenCalled();
  });
  test('authorization expiring while checks wait cannot be claimed or sent', async () => {
    const s = setup(); let reads = 0;
    const executor = new IndependentWithdrawalExecutor(s.store, s.adapter, s.readiness, keys, () => reads++ === 0 ? now : now + 60001);
    expect(await executor.execute(binding.reference)).toMatchObject({ state: 'held', reason: 'authorization_expired_before_claim' });
    expect(s.tx.claim).not.toHaveBeenCalled(); expect(s.adapter.submit).not.toHaveBeenCalled();
  });
  test('ambiguous submission never retries or refunds', async () => {
    const s = setup(); s.adapter.submit.mockRejectedValue(new Error('timeout'));
    expect(await s.executor.execute(binding.reference)).toMatchObject({ state: 'unknown' });
    expect(s.adapter.submit).toHaveBeenCalledTimes(1); expect(s.store.recordSubmission).not.toHaveBeenCalled(); expect(s.store.recordUnknown).toHaveBeenCalledTimes(1);
  });
  test('unbound receipt cannot become submitted', async () => {
    const s = setup(); s.adapter.submit.mockResolvedValue({ reference: 'other', digest: withdrawalDigest(binding), receipt: 'receipt' });
    expect(await s.executor.execute(binding.reference)).toMatchObject({ state: 'unknown' }); expect(s.store.recordSubmission).not.toHaveBeenCalled();
  });
  test('claims authorization durably before one provider write', async () => {
    const s = setup(); expect(await s.executor.execute(binding.reference)).toMatchObject({ state: 'submitted' });
    expect(s.tx.claim).toHaveBeenCalledWith(binding, ['owner', 'reviewer']);
    expect(s.tx.claim.mock.invocationCallOrder[0]).toBeLessThan(s.adapter.submit.mock.invocationCallOrder[0]);
    expect(s.adapter.submit).toHaveBeenCalledTimes(1); expect(s.store.recordUnknown).not.toHaveBeenCalled();
  });
});
