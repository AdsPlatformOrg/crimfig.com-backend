import { generateKeyPairSync } from 'crypto';
import { FinancialProofIssuer } from '../../../shared/src/financial-security/proof-issuer';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
import { verifyFinancialProof } from '../../../shared/src/financial-security/authorization';

describe('PLAN-0052 Auth transaction proof issuance', () => {
  const now = 1_800_000_000_000;
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  function setup() {
    const challenge = { id: 'challenge', actorId: 'owner', personId: 'person', purpose: 'owner_authorization', attempts: 0, consumed: false, expiresAt: now + 60_000,
      binding: { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: 'owner', ownerPersonId: 'person', destinationKey: 'bank-account', destinationVersion: 'v1',
        recipientCode: 'recipient', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60_000 } };
    const tx = { loadForUpdate: jest.fn().mockResolvedValue(challenge), eligible: jest.fn().mockResolvedValue(true), incrementAttempts: jest.fn().mockResolvedValue(undefined),
      consumeFinancialTotp: jest.fn().mockResolvedValue(true), complete: jest.fn().mockResolvedValue(undefined) };
    const store = { transaction: jest.fn(async work => work(tx)) };
    return { challenge, tx, store, issuer: new FinancialProofIssuer(store, 'auth', privateKey, () => now) };
  }
  test('backup codes cannot mint financial authorization or consume an attempt', async () => {
    const s = setup(); await expect(s.issuer.confirm('owner', 'challenge', 'BACKUP01')).rejects.toThrow(); expect(s.store.transaction).not.toHaveBeenCalled();
  });
  test.each(['wrong-owner', 'expired', 'consumed', 'locked', 'revoked', 'self-review'])('rejects %s without issuing proof', async reason => {
    const s = setup();
    if (reason === 'expired') s.challenge.expiresAt = now;
    if (reason === 'consumed') s.challenge.consumed = true;
    if (reason === 'locked') s.challenge.attempts = 5;
    if (reason === 'revoked') s.tx.eligible.mockResolvedValue(false);
    if (reason === 'self-review') s.challenge.purpose = 'independent_review';
    await expect(s.issuer.confirm(reason === 'wrong-owner' ? 'other' : 'owner', 'challenge', '123456')).rejects.toThrow();
    expect(s.tx.complete).not.toHaveBeenCalled(); expect(s.tx.consumeFinancialTotp).not.toHaveBeenCalled();
  });
  test('failed TOTP commits its attempt before returning rejection', async () => {
    const s = setup(); s.tx.consumeFinancialTotp.mockResolvedValue(false);
    await expect(s.issuer.confirm('owner', 'challenge', '123456')).rejects.toThrow();
    expect(s.tx.incrementAttempts).toHaveBeenCalledTimes(1); expect(s.tx.complete).not.toHaveBeenCalled();
    expect(await s.store.transaction.mock.results[0].value).toBeNull();
  });
  test('valid proof is bound to the stored intent, never a caller-provided amount', async () => {
    const s = setup(); const proof = await s.issuer.confirm('owner', 'challenge', '123456');
    expect(verifyFinancialProof(proof, s.challenge.binding as any, 'owner_authorization', { auth: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, now)).toBe(true);
    expect(s.tx.complete).toHaveBeenCalledWith('challenge', proof);
  });
});
