import { evaluateWithdrawal, independentReviewQuorum, verifyFinancialProof } from './authorization';
import { ExecutionAuthorityStore } from './executor';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

/** Read-only approval decision. An unsolicited callback cannot create an intent, claim, debit or refund. */
export class ProviderApprovalGate {
  constructor(private readonly store: ExecutionAuthorityStore, private readonly keys: Readonly<Record<string,string>>,
    private readonly healthy: () => Promise<boolean>, private readonly clock: () => number = Date.now) {}
  async approve(environment: 'test'|'live', input: unknown): Promise<boolean> {
    if (!policy.executionEnabled || !await this.healthy()) return false;
    const request = input as any;
    if (!request || !/^wd_[a-f0-9]{40}$/.test(request.reference)) return false;
    try {
      return await this.store.transaction(async tx => {
        const record = await tx.load(request.reference);
        if (!record || !['started','unknown','submitted'].includes(record.state)) return false;
        const b = record.binding, now = this.clock();
        if (b.environment !== environment || request.amount !== b.amountKobo || request.currency !== 'NGN'
          || request.recipient !== b.recipientCode || request.source !== 'balance') return false;
        const assessment = await tx.assess(b);
        // This transfer already owns one allocation. Remove that allocation before testing the same caps again.
        for (const field of ['ownerDayUsdCents','destinationDayUsdCents','platformHourUsdCents','platformDayUsdCents','outstandingUsdCents'] as const) {
          if (assessment[field] < b.amountUsdCents) return false;
          assessment[field] -= b.amountUsdCents;
        }
        const decision = evaluateWithdrawal(b, assessment, now);
        return decision.outcome === 'review' && verifyFinancialProof(record.ownerProof,b,'owner_authorization',this.keys,now)
          && independentReviewQuorum(b,record.reviews,tx.reviewKeys?await tx.reviewKeys():{},now,decision.reviewers,await tx.platformAdmins(),new Set());
      });
    } catch { return false; }
  }
}
