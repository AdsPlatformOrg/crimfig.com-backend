import { generateKeyPairSync, sign } from 'crypto';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
import { evaluateWithdrawal, FinancialProof, IndependentAssessment, independentReviewQuorum, proofMessage, verifyFinancialProof, WithdrawalBinding, withdrawalDigest } from '../../../shared/src/financial-security/authorization';

describe('PLAN-0052 independent withdrawal authorization', () => {
  const now = 1_800_000_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { auth: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const binding: WithdrawalBinding = { reference: 'wd_reference', requestId: 'request', ownerId: 'owner', ownerPersonId: 'person-owner',
    destinationKey: 'canonical-bank-account', destinationVersion: 'destination-v1', recipientCode: 'RCP_123', amountUsdCents: 5000, amountKobo: 7_000_000,
    feeKobo: 5000, exchangeRateId: 'fx-v1', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60_000 };
  const assessment = (overrides: Partial<IndependentAssessment> = {}): IndependentAssessment => ({ observedAt: now, digest: withdrawalDigest(binding),
    risk: 'standard', clearedFundsVerified: true, frozen: false, protectionHealthy: true, destinationVerifiedAt: now - policy.destinationCooldownMs,
    lastAccountRecoveryAt: null, ownerDayUsdCents: 0, destinationDayUsdCents: 0, platformHourUsdCents: 0, platformDayUsdCents: 0,
    outstandingUsdCents: 0, hotFloatUsdCents: 100_000, ...overrides });
  const proof = (overrides: Partial<FinancialProof> = {}): FinancialProof => {
    const p: FinancialProof = { version: 1, keyId: 'auth', purpose: 'owner_authorization', audience: 'financial-executor', environment: 'test',
      digest: withdrawalDigest(binding), actorId: 'owner', personId: 'person-owner', nonce: 'nonce', issuedAt: now, expiresAt: now + 60_000, signature: '', ...overrides };
    p.signature = sign(null, proofMessage(p), privateKey).toString('base64url'); return p;
  };
  test.each([0, -1, 499, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid money %s', amountUsdCents => {
    expect(evaluateWithdrawal({ ...binding, amountUsdCents }, assessment(), now).outcome).toBe('deny');
  });
  test.each(['amountUsdCents', 'recipientCode', 'destinationVersion', 'quoteId', 'environment', 'feeKobo'] as const)('rejects changed %s', key => {
    const changed = { ...binding, [key]: typeof binding[key] === 'number' ? Number(binding[key]) + 1 : key === 'environment' ? 'live' : 'changed' } as WithdrawalBinding;
    expect(verifyFinancialProof(proof(), changed, 'owner_authorization', keys, now)).toBe(false);
  });
  test.each([{ expiresAt: now }, { issuedAt: now + 1 }, { keyId: 'unknown' }, { actorId: 'other' }, { personId: 'other' },
    { purpose: 'independent_review' }, { environment: 'live' }, { expiresAt: now + policy.proofLifetimeMs + 1 }])('rejects invalid signed proof %j', overrides => {
    expect(verifyFinancialProof(proof(overrides as Partial<FinancialProof>), binding, 'owner_authorization', keys, now)).toBe(false);
  });
  test('rejects forged signatures and untrusted keys', () => {
    expect(verifyFinancialProof({ ...proof(), signature: 'A'.repeat(86) }, binding, 'owner_authorization', keys, now)).toBe(false);
    expect(verifyFinancialProof(proof(), binding, 'owner_authorization', {}, now)).toBe(false);
  });
  test.each([{ frozen: true }, { protectionHealthy: false }, { clearedFundsVerified: false }, { observedAt: now - 30_001 },
    { observedAt: now + 1 }, { digest: 'wrong' }, { outstandingUsdCents: NaN }, { ownerDayUsdCents: -1 },
    { destinationVerifiedAt: now }, { lastAccountRecoveryAt: now }, { platformDayUsdCents: 250_000 }, { hotFloatUsdCents: 300_001 }])('holds unsafe assessment %j', overrides => {
    expect(evaluateWithdrawal(binding, assessment(overrides), now).outcome).toBe('hold');
  });
  test('denies risk and stale policy', () => {
    expect(evaluateWithdrawal(binding, assessment({ risk: 'deny' }), now).outcome).toBe('deny');
    expect(evaluateWithdrawal({ ...binding, policyVersion: 'old' }, assessment(), now).outcome).toBe('deny');
  });
  test('rejects beneficiary, revoked grant, consumed proof and multiple accounts of one human', () => {
    const ownerReview = proof({ purpose: 'independent_review' });
    expect(independentReviewQuorum(binding, [ownerReview], keys, now, 1, new Map([['owner', 'person-owner']]), new Set())).toBe(false);
    const a = proof({ purpose: 'independent_review', actorId: 'a', personId: 'person-a' });
    const b = proof({ purpose: 'independent_review', actorId: 'b', personId: 'person-a', nonce: 'b' });
    const grants = new Map([['a', 'person-a'], ['b', 'person-a']]);
    expect(independentReviewQuorum(binding, [a, b], keys, now, 2, grants, new Set())).toBe(false);
    expect(independentReviewQuorum(binding, [a], keys, now, 1, new Map(), new Set())).toBe(false);
    expect(independentReviewQuorum(binding, [a], keys, now, 1, grants, new Set(['nonce']))).toBe(false);
  });
  test('configuration cannot be mutated and execution defaults disabled', () => {
    expect(Object.isFrozen(policy)).toBe(true); expect(Object.isFrozen(policy.recipients)).toBe(true);
    expect(policy.executionEnabled).toBe(false);
    expect(policy.recipients).toEqual(['jed@crimfig.com', 'jedacctwo@gmail.com']);
  });
  test('valid proof verifies and policy requires review, never authorizes execution itself', () => {
    expect(verifyFinancialProof(proof(), binding, 'owner_authorization', keys, now)).toBe(true);
    expect(evaluateWithdrawal(binding, assessment(), now)).toEqual({ outcome: 'review', reviewers: 1, digest: withdrawalDigest(binding) });
    expect(evaluateWithdrawal(binding, assessment({ risk: 'elevated' }), now)).toMatchObject({ outcome: 'review', reviewers: 2 });
    expect(evaluateWithdrawal(binding, assessment({ ownerDayUsdCents: 45_000 }), now).outcome).toBe('review');
    expect(evaluateWithdrawal(binding, assessment({ ownerDayUsdCents: 45_001 }), now).outcome).toBe('hold');
  });
  test('accepts two independently granted distinct reviewers', () => {
    const proofs = ['a', 'b'].map(id => proof({ purpose: 'independent_review', actorId: id, personId: `person-${id}`, nonce: id }));
    expect(independentReviewQuorum(binding, proofs, keys, now, 2, new Map([['a', 'person-a'], ['b', 'person-b']]), new Set())).toBe(true);
  });
});
