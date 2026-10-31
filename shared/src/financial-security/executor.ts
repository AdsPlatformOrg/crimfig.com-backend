import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';
import { evaluateWithdrawal, FinancialProof, IndependentAssessment, independentReviewQuorum, verifyFinancialProof, WithdrawalBinding, withdrawalDigest } from './authorization';

export interface ExecutionRecord {
  binding: WithdrawalBinding;
  ownerProof: FinancialProof;
  reviews: FinancialProof[];
  state: 'pending' | 'started' | 'unknown' | 'submitted';
}
export interface AuthorityTransaction {
  load(reference: string): Promise<ExecutionRecord | null>;
  assess(binding: WithdrawalBinding): Promise<IndependentAssessment>;
  platformAdmins(): Promise<ReadonlyMap<string, string>>;
  reviewKeys?(): Promise<Readonly<Record<string,string>>>;
  consumedNonces(nonces: string[]): Promise<ReadonlySet<string>>;
  /** Atomically allocate all exposure, consume proof nonces and persist started before external I/O. */
  claim(binding: WithdrawalBinding, nonces: string[]): Promise<void>;
  /** Same transaction as state change; creates both recipient intents atomically. */
  audit(reference: string, event: string): Promise<void>;
}
export interface ExecutionAuthorityStore {
  /** Serialized global allocation lock plus reference lock, with transaction/statement timeouts. */
  transaction<T>(work: (tx: AuthorityTransaction) => Promise<T>): Promise<T>;
  recordSubmission(reference: string, digest: string, providerReceipt: string): Promise<void>;
  recordUnknown(reference: string, digest: string): Promise<void>;
}
export interface IsolatedPayoutAdapter {
  submit(binding: WithdrawalBinding): Promise<{ reference: string; digest: string; receipt: string }>;
}
export interface ExecutionReadiness {
  /** Supplied by trusted deployment capability checks, never a public request or an env boolean alone. */
  independentlyVerified(): Promise<boolean>;
}
export type ExecutionResult = { reference: string; state: 'held' | 'recovery_required' | 'submitted' | 'unknown'; reason?: string };

/** Runs ONLY in the separately administered execution process. No generic URL, amount or recipient API. */
export class IndependentWithdrawalExecutor {
  constructor(private readonly store: ExecutionAuthorityStore, private readonly adapter: IsolatedPayoutAdapter,
    private readonly readiness: ExecutionReadiness, private readonly authKeys: Readonly<Record<string, string>>,
    private readonly clock: () => number = Date.now) {}

  async execute(reference: string): Promise<ExecutionResult> {
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new Error('Invalid withdrawal reference');
    // A source-reviewed release is required. Neither readiness nor caller input can override this switch.
    if (!policy.executionEnabled) return { reference, state: 'held', reason: 'execution_not_released' };
    return this.executeReleased(reference);
  }
  async available(): Promise<boolean> {
    if (!policy.executionEnabled) return false;
    try { return await this.readiness.independentlyVerified(); } catch { return false; }
  }

  private async executeReleased(reference: string): Promise<ExecutionResult> {
    if (!await this.readiness.independentlyVerified()) return { reference, state: 'held', reason: 'protection_unavailable' };
    const authorized = await this.store.transaction(async tx => {
      const record = await tx.load(reference);
      if (!record || record.binding.reference !== reference) throw new Error('Unknown withdrawal');
      if (record.state !== 'pending') return null;
      const { binding } = record;
      const now = this.clock();
      const assessment = await tx.assess(binding);
      const decision = evaluateWithdrawal(binding, assessment, now);
      const deny = async (reason: string) => { await tx.audit(reference, reason); return { denied: reason } as const; };
      if (decision.outcome !== 'review') return deny(decision.reason);
      if (!verifyFinancialProof(record.ownerProof, binding, 'owner_authorization', this.authKeys, now)) return deny('owner_proof_rejected');
      const nonces = [record.ownerProof.nonce, ...record.reviews.map(p => p.nonce)];
      const consumed = await tx.consumedNonces(nonces);
      if (consumed.has(record.ownerProof.nonce)) return deny('owner_proof_replayed');
      const grants = await tx.platformAdmins();
      const reviewKeys=tx.reviewKeys?await tx.reviewKeys():{};
      if (!independentReviewQuorum(binding, record.reviews, reviewKeys, now, decision.reviewers, grants, consumed)) return deny('independent_review_required');
      // Consume only valid current reviewer proofs, so untrusted extra proof entries cannot poison nonce storage.
      const reviewNonces = record.reviews.filter(p => verifyFinancialProof(p, binding, 'independent_review', reviewKeys, now)
        && p.actorId !== binding.ownerId && p.personId !== binding.ownerPersonId && grants.get(p.actorId) === p.personId && !consumed.has(p.nonce)).map(p => p.nonce);
      if (reviewNonces.includes(record.ownerProof.nonce)) return deny('nonce_collision');
      const claimTime = this.clock();
      if (claimTime >= binding.expiresAt || claimTime >= record.ownerProof.expiresAt
        || claimTime - assessment.observedAt > policy.assessmentLifetimeMs
        || !independentReviewQuorum(binding, record.reviews, reviewKeys, claimTime, decision.reviewers, grants, consumed)) return deny('authorization_expired_before_claim');
      await tx.claim(binding, [...new Set([record.ownerProof.nonce, ...reviewNonces])]);
      await tx.audit(reference, 'execution_started');
      return { binding } as const;
    });
    if (!authorized) return { reference, state: 'recovery_required' };
    if ('denied' in authorized) return { reference, state: 'held', reason: authorized.denied };
    const binding = authorized.binding;
    const digest = withdrawalDigest(binding);
    try {
      // Never retry this write. The isolated provider approval callback rechecks freeze/revocation before approval.
      const result = await this.adapter.submit(binding);
      if (result.reference !== reference || result.digest !== digest || !result.receipt) throw new Error('Unbound provider receipt');
      await this.store.recordSubmission(reference, digest, result.receipt);
      return { reference, state: 'submitted' };
    } catch {
      // A persistence failure after provider acceptance is also unknown; it is never safe to resend/refund.
      await this.store.recordUnknown(reference, digest);
      return { reference, state: 'unknown' };
    }
  }
}
