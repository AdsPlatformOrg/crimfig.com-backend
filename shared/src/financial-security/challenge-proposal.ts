import { createPublicKey, verify } from 'crypto';
import { FinancialProof, WithdrawalBinding, withdrawalDigest } from './authorization';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

export interface ChallengeProposal {
  version: 1; keyId: string; audience: 'financial-auth'; challengeId: string;
  actorId: string; personId: string; purpose: FinancialProof['purpose'];
  binding: WithdrawalBinding; issuedAt: number; expiresAt: number; signature: string;
}
export function proposalMessage(p: Omit<ChallengeProposal, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify(['financial-challenge-v1', p.version, p.keyId, p.audience, p.challengeId,
    p.actorId, p.personId, p.purpose, withdrawalDigest(p.binding), p.issuedAt, p.expiresAt]));
}
/** Only the independently configured authority keyring can attest a proposed transaction. */
export function verifyChallengeProposal(p: ChallengeProposal, actorId: string, keys: Readonly<Record<string, string>>, now: number): boolean {
  try {
    if (p.version !== 1 || p.audience !== 'financial-auth' || p.actorId !== actorId
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(p.challengeId)
      || typeof p.personId !== 'string' || !p.personId || p.personId.length > 256
      || !['owner_authorization', 'independent_review'].includes(p.purpose)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)
      || p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt
      || p.expiresAt > p.binding.expiresAt || p.expiresAt - p.issuedAt > policy.proofLifetimeMs
      || p.binding.policyVersion !== policy.version || !Object.prototype.hasOwnProperty.call(keys, p.keyId)
      || !/^[A-Za-z0-9_-]{86}$/.test(p.signature)) return false;
    if (p.purpose === 'owner_authorization' && (p.actorId !== p.binding.ownerId || p.personId !== p.binding.ownerPersonId)) return false;
    if (p.purpose === 'independent_review' && (p.actorId === p.binding.ownerId || p.personId === p.binding.ownerPersonId)) return false;
    const key = createPublicKey(keys[p.keyId]);
    return key.asymmetricKeyType === 'ed25519' && verify(null, proposalMessage(p), key, Buffer.from(p.signature, 'base64url'));
  } catch { return false; }
}
