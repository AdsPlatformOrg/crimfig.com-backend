import { createHash, createPublicKey, verify } from 'crypto';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

/** Fixed-field serialization deliberately excludes caller-defined metadata. */
export interface WithdrawalBinding {
  reference: string; requestId: string; ownerId: string; ownerPersonId: string;
  destinationKey: string; destinationVersion: string; recipientCode: string; amountUsdCents: number;
  amountKobo: number; feeKobo: number; exchangeRateId: string; quoteId: string;
  environment: 'test' | 'live'; policyVersion: string; expiresAt: number;
}
const fields: (keyof WithdrawalBinding)[] = ['reference', 'requestId', 'ownerId', 'ownerPersonId',
  'destinationKey', 'destinationVersion', 'recipientCode', 'amountUsdCents', 'amountKobo', 'feeKobo',
  'exchangeRateId', 'quoteId', 'environment', 'policyVersion', 'expiresAt'];
export function withdrawalDigest(binding: WithdrawalBinding): string {
  if (!binding || fields.some(key => binding[key] === undefined)) throw new Error('Incomplete withdrawal binding');
  for (const key of fields) {
    const value = binding[key];
    if (['amountUsdCents', 'amountKobo', 'feeKobo', 'expiresAt'].includes(key)) {
      if (!Number.isSafeInteger(value) || Number(value) < (key === 'feeKobo' ? 0 : 1)) throw new Error('Invalid monetary/time binding');
    } else if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid binding identifier');
  }
  if (!['test', 'live'].includes(binding.environment)) throw new Error('Invalid environment');
  return createHash('sha256').update(JSON.stringify(['withdrawal-v1', 'paystack', 'NGN', ...fields.map(key => binding[key])])).digest('hex');
}

export interface FinancialProof {
  version: 1; keyId: string; purpose: 'owner_authorization' | 'independent_review';
  audience: 'financial-executor'; environment: 'test' | 'live'; digest: string;
  actorId: string; personId: string; nonce: string; issuedAt: number; expiresAt: number;
  signature: string;
}
export function proofMessage(proof: Omit<FinancialProof, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify(['financial-proof-v1', proof.version, proof.keyId, proof.purpose,
    proof.audience, proof.environment, proof.digest, proof.actorId, proof.personId, proof.nonce, proof.issuedAt, proof.expiresAt]));
}
/** Public keys must come from independently managed Auth trust configuration, never request data. */
export function verifyFinancialProof(proof: FinancialProof, binding: WithdrawalBinding,
  purpose: FinancialProof['purpose'], keys: Readonly<Record<string, string>>, now: number): boolean {
  try {
    if (!Number.isSafeInteger(now) || proof.version !== 1 || proof.purpose !== purpose || proof.audience !== 'financial-executor'
      || proof.environment !== binding.environment || proof.digest !== withdrawalDigest(binding)
      || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
      || proof.issuedAt > now || proof.expiresAt <= now || proof.expiresAt > binding.expiresAt
      || proof.expiresAt <= proof.issuedAt || proof.expiresAt - proof.issuedAt > policy.proofLifetimeMs
      || ![proof.actorId, proof.personId, proof.nonce, proof.keyId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)
      || !Object.prototype.hasOwnProperty.call(keys, proof.keyId)
      || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) return false;
    if (purpose === 'owner_authorization' && (proof.actorId !== binding.ownerId || proof.personId !== binding.ownerPersonId)) return false;
    const key = createPublicKey(keys[proof.keyId]);
    return key.asymmetricKeyType === 'ed25519' && verify(null, proofMessage(proof), key, Buffer.from(proof.signature, 'base64url'));
  } catch { return false; }
}

export interface IndependentAssessment {
  observedAt: number; digest: string; risk: 'standard' | 'elevated' | 'deny';
  clearedFundsVerified: boolean; frozen: boolean; protectionHealthy: boolean;
  destinationVerifiedAt: number; lastAccountRecoveryAt: number | null;
  ownerDayUsdCents: number; destinationDayUsdCents: number; platformHourUsdCents: number;
  platformDayUsdCents: number; outstandingUsdCents: number; hotFloatUsdCents: number;
}
export type PolicyDecision = { outcome: 'deny' | 'hold'; reason: string } | { outcome: 'review'; reviewers: 1 | 2; digest: string };
/** Assessment/exposure must be loaded by the authority under its allocation lock, never supplied by public Billing callers. */
export function evaluateWithdrawal(binding: WithdrawalBinding, assessment: IndependentAssessment, now: number): PolicyDecision {
  let digest: string;
  try { digest = withdrawalDigest(binding); } catch { return { outcome: 'deny', reason: 'invalid_intent' }; }
  if (!Number.isSafeInteger(now) || binding.expiresAt <= now || binding.policyVersion !== policy.version) return { outcome: 'deny', reason: 'stale_intent' };
  if (binding.amountUsdCents < policy.minimumWithdrawalUsdCents) return { outcome: 'deny', reason: 'below_minimum' };
  if (!assessment || assessment.digest !== digest || !Number.isSafeInteger(assessment.observedAt)
    || assessment.observedAt > now || now - assessment.observedAt > policy.assessmentLifetimeMs) return { outcome: 'hold', reason: 'assessment_unavailable' };
  if (assessment.frozen !== false || assessment.protectionHealthy !== true || assessment.clearedFundsVerified !== true) return { outcome: 'hold', reason: 'protection_hold' };
  if (!['standard', 'elevated'].includes(assessment.risk)) return { outcome: 'deny', reason: 'risk_denied' };
  if (!Number.isSafeInteger(assessment.destinationVerifiedAt) || assessment.destinationVerifiedAt <= 0
    || now - assessment.destinationVerifiedAt < policy.destinationCooldownMs
    || (assessment.lastAccountRecoveryAt !== null && (!Number.isSafeInteger(assessment.lastAccountRecoveryAt)
      || assessment.lastAccountRecoveryAt <= 0 || now - assessment.lastAccountRecoveryAt < policy.recoveryCooldownMs))) return { outcome: 'hold', reason: 'cooldown' };
  const counters = ['ownerDayUsdCents', 'destinationDayUsdCents', 'platformHourUsdCents', 'platformDayUsdCents', 'outstandingUsdCents', 'hotFloatUsdCents'] as const;
  if (counters.some(key => !Number.isSafeInteger(assessment[key]) || assessment[key] < 0)) return { outcome: 'hold', reason: 'invalid_exposure' };
  if (binding.amountUsdCents > policy.withdrawalUsdCents || assessment.hotFloatUsdCents > policy.hotFloatUsdCents
    || counters.filter(key => key !== 'hotFloatUsdCents').some(key => binding.amountUsdCents > policy[key] - assessment[key])) return { outcome: 'hold', reason: 'exposure_limit' };
  return { outcome: 'review', reviewers: binding.amountUsdCents > policy.secondReviewerAboveUsdCents || assessment.risk === 'elevated' ? 2 : 1, digest };
}

/** Cryptographic validity alone is insufficient: grant and nonce checks are independently reloaded at consumption. */
export function independentReviewQuorum(binding: WithdrawalBinding, proofs: FinancialProof[], keys: Readonly<Record<string, string>>,
  now: number, required: 1 | 2, activePlatformAdmins: ReadonlyMap<string, string>, consumedNonces: ReadonlySet<string>): boolean {
  if (required !== 1 && required !== 2) return false;
  const people = new Set<string>();
  for (const proof of proofs) {
    if (!verifyFinancialProof(proof, binding, 'independent_review', keys, now)
      || proof.actorId === binding.ownerId || proof.personId === binding.ownerPersonId
      || activePlatformAdmins.get(proof.actorId) !== proof.personId || consumedNonces.has(proof.nonce)) continue;
    people.add(proof.personId);
  }
  return people.size >= required;
}
