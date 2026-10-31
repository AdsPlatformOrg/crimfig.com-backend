import { assessFinancialObservation, IndependentFinancialObservation } from '../../../shared/src/financial-security/risk-observations';
import { WithdrawalBinding, withdrawalDigest } from '../../../shared/src/financial-security/authorization';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';
describe('independent risk observations', () => {
  const now = 1800000000000;
  const binding: WithdrawalBinding = { reference: 'wd_' + 'a'.repeat(40), requestId: 'request', ownerId: 'owner', ownerPersonId: 'person', destinationKey: 'bank', destinationVersion: 'v1', recipientCode: 'RCP_1', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60000 };
  const observation = (): IndependentFinancialObservation => ({ digest: withdrawalDigest(binding), observedAt: now, clearedUsdCents: 5000, reservedUsdCents: 5000, providerFloatUsdCents: 10000, destinationVerifiedAt: now - policy.destinationCooldownMs, lastAccountRecoveryAt: null, provenanceVerified: true, providerReconciled: true, auditHealthy: true, alertingHealthy: true, identityHealthy: true, frozen: false, elevatedRisk: false });
  test.each([{ digest: 'forged' }, { observedAt: now - 30001 }, { observedAt: now + 1 }, { clearedUsdCents: NaN }, { reservedUsdCents: -1 }])('rejects invalid evidence %j', change => {
    expect(() => assessFinancialObservation(binding, { ...observation(), ...change }, now)).toThrow();
  });
  test('unverified provenance or insufficient reserved funds never clears a withdrawal', () => {
    expect(assessFinancialObservation(binding, { ...observation(), provenanceVerified: false }, now).clearedFundsVerified).toBe(false);
    expect(assessFinancialObservation(binding, { ...observation(), reservedUsdCents: 4999 }, now).clearedFundsVerified).toBe(false);
  });
  test('missing protection health denies risk approval', () => {
    expect(assessFinancialObservation(binding, { ...observation(), alertingHealthy: false }, now)).toMatchObject({ risk: 'deny', protectionHealthy: false });
  });
  test('verified observation preserves exact digest and elevated review requirement', () => {
    expect(assessFinancialObservation(binding, { ...observation(), elevatedRisk: true }, now)).toMatchObject({ digest: withdrawalDigest(binding), clearedFundsVerified: true, risk: 'elevated' });
  });
});
