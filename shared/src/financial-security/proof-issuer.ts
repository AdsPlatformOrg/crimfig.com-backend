import { createPrivateKey, randomUUID, sign } from 'crypto';
import { FinancialProof, proofMessage, WithdrawalBinding, withdrawalDigest } from './authorization';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

export interface FinancialChallenge {
  id: string; actorId: string; personId: string; purpose: FinancialProof['purpose'];
  binding: WithdrawalBinding; expiresAt: number; attempts: number; consumed: boolean;
}
export interface ChallengeTransaction {
  loadForUpdate(id: string): Promise<FinancialChallenge | null>;
  /** Re-read active identity, independent person mapping, grant and account-recovery cooldown. */
  eligible(challenge: FinancialChallenge, now: number): Promise<boolean>;
  incrementAttempts(id: string): Promise<void>;
  /** TOTP only; atomically consume device + time step. Backup/login proofs cannot authorize money. */
  consumeFinancialTotp(actorId: string, code: string, now: number): Promise<boolean>;
  complete(id: string, proof: FinancialProof): Promise<void>;
}
export interface FinancialChallengeStore {
  transaction<T>(work: (tx: ChallengeTransaction) => Promise<T>): Promise<T>;
}
/** Auth-only composition: signing private key must never be deployed to Billing or the executor. */
export class FinancialProofIssuer {
  constructor(private readonly store: FinancialChallengeStore, private readonly keyId: string,
    private readonly privateKeyPem: string, private readonly clock: () => number = Date.now) {}
  async confirm(actorId: string, challengeId: string, code: string): Promise<FinancialProof> {
    if (!actorId || !challengeId || !/^\d{6}$/.test(code)) throw new Error('Invalid transaction authorization');
    const key = createPrivateKey(this.privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || !/^[A-Za-z0-9_-]{1,64}$/.test(this.keyId)) throw new Error('Financial signing authority unavailable');
    const result = await this.store.transaction(async tx => {
      const challenge = await tx.loadForUpdate(challengeId);
      const now = this.clock();
      if (!challenge || challenge.actorId !== actorId || challenge.consumed || !Number.isSafeInteger(challenge.attempts)
        || challenge.attempts < 0 || challenge.attempts >= 5 || challenge.expiresAt <= now || challenge.binding.expiresAt <= now
        || !Number.isSafeInteger(now) || !Number.isSafeInteger(challenge.expiresAt)
        || challenge.binding.policyVersion !== policy.version) return null;
      if (challenge.purpose === 'owner_authorization') {
        if (actorId !== challenge.binding.ownerId || challenge.personId !== challenge.binding.ownerPersonId) return null;
      } else if (challenge.purpose !== 'independent_review' || actorId === challenge.binding.ownerId || challenge.personId === challenge.binding.ownerPersonId) return null;
      if (!await tx.eligible(challenge, now)) return null;
      const digest = withdrawalDigest(challenge.binding);
      await tx.incrementAttempts(challengeId);
      // Return a denial normally so the failed attempt is committed; throwing here would roll it back.
      if (!await tx.consumeFinancialTotp(actorId, code, now)) return null;
      const proof: FinancialProof = { version: 1, keyId: this.keyId, purpose: challenge.purpose, audience: 'financial-executor',
        environment: challenge.binding.environment, digest, actorId, personId: challenge.personId, nonce: randomUUID(),
        issuedAt: now, expiresAt: Math.min(challenge.expiresAt, challenge.binding.expiresAt, now + policy.proofLifetimeMs), signature: '' };
      proof.signature = sign(null, proofMessage(proof), key).toString('base64url');
      await tx.complete(challengeId, proof);
      return proof;
    });
    if (!result) throw new Error('Transaction authorization rejected or expired');
    return result;
  }
}
