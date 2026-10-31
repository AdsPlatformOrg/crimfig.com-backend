import { generateKeyPairSync, sign } from 'crypto';
import { ChallengeProposal, proposalMessage, verifyChallengeProposal } from '../../../shared/src/financial-security/challenge-proposal';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';

describe('PLAN-0052 trusted Auth challenge proposals', () => {
  const now = 1_800_000_000_000;
  const pair = generateKeyPairSync('ed25519');
  const keys = { authority: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
  const proposal = (): ChallengeProposal => {
    const p: ChallengeProposal = { version: 1, keyId: 'authority', audience: 'financial-auth', challengeId: '11111111-1111-4111-8111-111111111111',
      actorId: 'owner', personId: 'person-owner', purpose: 'owner_authorization', issuedAt: now, expiresAt: now + 60000, signature: '',
      binding: { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: 'owner', ownerPersonId: 'person-owner', destinationKey: 'account', destinationVersion: 'v1',
        recipientCode: 'RCP_123', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: now + 60000 } };
    p.signature = sign(null, proposalMessage(p), pair.privateKey).toString('base64url'); return p;
  };
  test.each(['actor', 'amount', 'destination', 'expiry', 'purpose', 'environment'])('rejects altered %s', field => {
    const p = proposal();
    if (field === 'actor') p.actorId = 'other';
    if (field === 'amount') p.binding.amountKobo++;
    if (field === 'destination') p.binding.destinationKey = 'other';
    if (field === 'expiry') p.expiresAt++;
    if (field === 'purpose') p.purpose = 'independent_review';
    if (field === 'environment') p.binding.environment = 'live';
    expect(verifyChallengeProposal(p, 'owner', keys, now)).toBe(false);
  });
  test('unknown key, stale proposal and wrong session cannot be accepted', () => {
    expect(verifyChallengeProposal(proposal(), 'owner', {}, now)).toBe(false);
    expect(verifyChallengeProposal(proposal(), 'owner', keys, now + 60000)).toBe(false);
    expect(verifyChallengeProposal(proposal(), 'other', keys, now)).toBe(false);
  });
  test('valid server-attested intent can be displayed before confirmation', () => {
    expect(verifyChallengeProposal(proposal(), 'owner', keys, now)).toBe(true);
  });
});
