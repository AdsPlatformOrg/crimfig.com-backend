import { createPrivateKey, randomUUID, sign } from 'crypto';
import { ChallengeProposal, proposalMessage } from './challenge-proposal';
import { evaluateWithdrawal, FinancialProof, independentReviewQuorum, verifyFinancialProof, WithdrawalBinding, withdrawalDigest } from './authorization';
import { IndependentWithdrawalExecutor } from './executor';
import { PostgresFinancialAuthority } from './postgres-authority';
import { PrivateRequest, signPrivateResponse, verifyPrivateRequest } from './private-transport';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';
import { PaystackProviderBroker } from './provider-broker';

export interface IndependentQuoteSource {
  /** Read immutable quote and current identity/destination using a separate read-only database identity. */
  binding(input: { userId: string; requestId: string; quoteId: string; bankAccountId: string; amountUsdCents: number }): Promise<WithdrawalBinding>;
  /** Re-read the actual Billing reservation before any execution; no caller-supplied claim boolean. */
  reservationMatches(binding: WithdrawalBinding): Promise<boolean>;
}
export interface WorkloadKey { publicKey: string; role: 'billing' | 'auth' }
export class FinancialPrivateApi {
  constructor(private readonly store: PostgresFinancialAuthority, private readonly quotes: IndependentQuoteSource,
    private readonly executor: IndependentWithdrawalExecutor, private readonly workloads: Readonly<Record<string, WorkloadKey>>,
    private readonly authKeys: Readonly<Record<string, string>>, private readonly signingKeyId: string, private readonly signingPrivateKey: string,
    private readonly providerBroker?: PaystackProviderBroker) {}
  async handle(path: string, request: PrivateRequest) {
    const key = this.workloads[request?.keyId];
    if (!key || request.path !== path || !verifyPrivateRequest(request, { [request.keyId]: key.publicKey })) throw new Error('Workload authentication rejected');
    const routes = key.role === 'billing'
      ? ['/internal/v1/withdrawals/prepare', '/internal/v1/withdrawals/authorize', '/internal/v1/withdrawals/execute', '/internal/v1/withdrawals/review', '/internal/v1/withdrawals/availability','/internal/v1/provider/request','/internal/v1/provider/webhook']
      : ['/internal/v1/withdrawals/challenge'];
    if (!routes.includes(path)) throw new Error('Workload scope denied');
    await this.store.consumeWorkloadNonce(request.keyId, request.nonce);
    const input = JSON.parse(request.body);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid authority request');
    let result: unknown;
    if (path.startsWith('/internal/v1/provider/')) {
      if(!this.providerBroker)throw new Error('Provider broker unavailable');
      result=path.endsWith('/webhook')?{valid:this.providerBroker.verifyWebhook(input.rawBase64,input.signature)}:await this.providerBroker.call(input);
    } else if (path.endsWith('/availability')) {
      result = { available: await this.executor.available() };
    } else if (path.endsWith('/prepare')) {
      const binding = await this.quotes.binding(input);
      await this.store.prepare(binding);
      result = { reference: binding.reference, digest: withdrawalDigest(binding), state: 'awaiting_authorization' };
    } else if (path.endsWith('/challenge')) {
      result = await this.store.transaction(async tx => {
        const record = await tx.load(input.reference);
        if (!record || record.state !== 'pending') throw new Error('Withdrawal challenge unavailable');
        const { binding } = record;
        const owner = input.userId === binding.ownerId;
        const personId = owner ? binding.ownerPersonId : (await tx.platformAdmins()).get(input.userId);
        if (!personId || (!owner && personId === binding.ownerPersonId)) throw new Error('Independent identity required');
        const now = Date.now();
        if (binding.expiresAt <= now) throw new Error('Withdrawal quote expired');
        const proposal: ChallengeProposal = { version: 1, keyId: this.signingKeyId, audience: 'financial-auth', challengeId: randomUUID(),
          actorId: input.userId, personId, purpose: owner ? 'owner_authorization' : 'independent_review', binding,
          issuedAt: now, expiresAt: Math.min(binding.expiresAt, now + policy.proofLifetimeMs), signature: '' };
        const key = createPrivateKey(this.signingPrivateKey); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid authority signing key');
        proposal.signature = sign(null, proposalMessage(proposal), key).toString('base64url'); return proposal;
      });
    } else if (path.endsWith('/review')) {
      const proof = input.proof as FinancialProof;
      if (proof?.purpose !== 'independent_review' || proof.actorId !== input.userId) throw new Error('Independent review proof required');
      await this.store.attachProof(input.reference, proof, this.authKeys, Date.now());
      result = { reference: input.reference, state: 'review_recorded' };
    } else if (path.endsWith('/authorize')) {
      if (!await this.executor.available()) throw new Error('Independent withdrawal protection is unavailable');
      const binding = await this.quotes.binding(input);
      await this.store.attachProof(binding.reference, input.ownerProof, this.authKeys, Date.now());
      result = await this.store.transaction(async tx => {
        const record = await tx.load(binding.reference);
        if (!record || withdrawalDigest(record.binding) !== withdrawalDigest(binding) || record.state !== 'pending') throw new Error('Withdrawal authorization unavailable');
        const decision = evaluateWithdrawal(binding, await tx.assess(binding), Date.now());
        const used = await tx.consumedNonces([record.ownerProof.nonce, ...record.reviews.map(p => p.nonce)]);
        if (decision.outcome !== 'review' || used.has(record.ownerProof.nonce)
          || !verifyFinancialProof(record.ownerProof, binding, 'owner_authorization', this.authKeys, Date.now())
          || !independentReviewQuorum(binding, record.reviews, tx.reviewKeys?await tx.reviewKeys():{}, Date.now(), decision.reviewers, await tx.platformAdmins(), used)) throw new Error('Independent withdrawal review required');
        return { state: 'authorized', userId: binding.ownerId, requestId: binding.requestId, quoteId: binding.quoteId,
          bankAccountId: input.bankAccountId, amountUsdCents: binding.amountUsdCents, digest: withdrawalDigest(binding) };
      });
    } else {
      const binding = await this.store.transaction(async tx => {
        const record = await tx.load(input.reference);
        if (!record || record.binding.ownerId !== input.userId || withdrawalDigest(record.binding) !== input.digest
          || record.binding.amountKobo !== input.amountKobo || record.binding.recipientCode !== input.recipientCode || record.binding.environment !== input.domain) throw new Error('Withdrawal execution binding mismatch');
        return record.binding;
      });
      if (!await this.quotes.reservationMatches(binding)) throw new Error('Independent ledger reservation proof unavailable');
      result = { ...await this.executor.execute(binding.reference), digest: withdrawalDigest(binding) };
    }
    return signPrivateResponse(request, result, this.signingKeyId, this.signingPrivateKey);
  }
}
