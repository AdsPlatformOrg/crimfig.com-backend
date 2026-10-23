import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { PaystackService } from '../providers/paystack.service';
import { verifiedTransferOutcome } from './withdrawal-state';

export interface RefundReviewInput {
  providerEvidenceId: string;
  retainedFeeKobo: number;
  retainedStampDutyKobo: number;
}

/** Manual evidence attestation by two separately authenticated finance operators.
 * Provider verification establishes the transfer identity/outcome, not retained charges.
 * Operators must inspect the referenced provider balance evidence before signing.
 */
@Injectable()
export class RefundReviewService {
  private readonly operators: ReadonlySet<string>;
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystack: PaystackService, config: ConfigService) {
    const values: unknown = JSON.parse(config.get<string>('BILLING_REFUND_OPERATOR_IDS') || '[]');
    if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) {
      throw new Error('BILLING_REFUND_OPERATOR_IDS must be a JSON array of account UUIDs');
    }
    this.operators = new Set(values.map(id => id.toLowerCase()));
  }
  private async authorize(actor: string, tx: any = this.db) {
    if (typeof actor !== 'string' || !this.operators.has(actor.toLowerCase())) throw new ForbiddenException('Finance operator access required');
    const [user] = await tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, actor)).for('share');
    if (user?.status !== 'ACTIVE') throw new ForbiddenException('Active finance operator access required');
  }
  private async lock(tx: any, reference: string) {
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
  }
  private async boundIntent(tx: any, actor: string, reference: string, proof: unknown) {
    const [intent] = await tx.select().from(schema.billingTransactions).where(eq(schema.billingTransactions.reference, reference)).for('update');
    if (!intent) throw new NotFoundException('Withdrawal not found');
    let meta: any; try { meta = JSON.parse(intent.metadata || '{}'); } catch { meta = {}; }
    if (intent.userId.toLowerCase() === actor.toLowerCase()) throw new ForbiddenException('Operators cannot reconcile their own withdrawals');
    if (intent.type !== 'wallet_withdraw' || intent.provider !== 'paystack' || meta.withdrawalVersion !== 2 ||
        meta.dispatch !== 'started' || !meta.payoutQuote || meta.domain !== this.paystack.paymentDomain()) throw new ConflictException('Withdrawal requires separate reconciliation');
    const outcome = verifiedTransferOutcome({ reference, amountKobo: intent.amountNgnKobo,
      recipientCode: meta.recipientCode, domain: meta.domain }, proof);
    if (outcome === 'success') throw new ConflictException('Refund evidence requires a failed or reversed transfer');
    return { intent, meta, outcome };
  }
  async prepare(actor: string, reference: string, input: RefundReviewInput) {
    await this.authorize(actor);
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    if (typeof input.providerEvidenceId !== 'string' || !input.providerEvidenceId.trim() || input.providerEvidenceId.length > 200 ||
        ![input.retainedFeeKobo, input.retainedStampDutyKobo].every(n => Number.isSafeInteger(n) && n >= 0)) throw new ConflictException('Invalid retained charge evidence');
    const proof = await this.paystack.verifyTransfer(reference);
    return this.db.transaction(async tx => {
      await this.lock(tx, reference); await this.authorize(actor, tx);
      const { meta, outcome } = await this.boundIntent(tx, actor, reference, proof);
      if (input.retainedFeeKobo > meta.payoutQuote.transferFeeKobo || input.retainedStampDutyKobo > meta.payoutQuote.stampDutyKobo) throw new ConflictException('Charges exceed reviewed quote');
      const key = `internal.withdrawal.refund.draft:${reference}`;
      const [prior] = await tx.select().from(schema.billingProviderEvents).where(and(eq(schema.billingProviderEvents.provider, 'paystack'), eq(schema.billingProviderEvents.reference, key)));
      if (prior) throw new ConflictException('Evidence already prepared; review the existing immutable draft');
      const payload = { version: 2, reviewKind: 'independent-authenticated-operators', reference, domain: meta.domain, currency: 'NGN', transferCode: (proof as any).transfer_code,
        outcome, quoteId: meta.payoutQuote.quoteId, providerEvidenceId: input.providerEvidenceId.trim(),
        retainedFeeKobo: input.retainedFeeKobo, retainedStampDutyKobo: input.retainedStampDutyKobo,
        preparedBy: actor.toLowerCase(), preparedAt: new Date().toISOString(), reviewedBy: null };
      const [draft] = await tx.insert(schema.billingProviderEvents).values({ provider: 'paystack', reference: key,
        eventType: 'internal.withdrawal.refund.draft', rawPayload: payload, processed: false }).returning();
      return { draftId: draft.id, evidence: payload };
    });
  }
  async read(actor: string, reference: string) {
    await this.authorize(actor);
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    const [draft] = await this.db.select().from(schema.billingProviderEvents).where(and(eq(schema.billingProviderEvents.provider, 'paystack'),
      eq(schema.billingProviderEvents.reference, `internal.withdrawal.refund.draft:${reference}`)));
    if (!draft) throw new NotFoundException('Evidence draft not found');
    return { draftId: draft.id, evidence: draft.rawPayload, approved: draft.processed };
  }
  async approve(actor: string, reference: string, draftId: string) {
    await this.authorize(actor);
    if (!/^wd_[a-f0-9]{40}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    const proof = await this.paystack.verifyTransfer(reference);
    return this.db.transaction(async tx => {
      await this.lock(tx, reference); await this.authorize(actor, tx);
      const { meta, outcome } = await this.boundIntent(tx, actor, reference, proof);
      const [draft] = await tx.select().from(schema.billingProviderEvents).where(and(eq(schema.billingProviderEvents.provider, 'paystack'),
        eq(schema.billingProviderEvents.reference, `internal.withdrawal.refund.draft:${reference}`))).for('update');
      if (!draft || draft.id !== draftId) throw new ConflictException('Review the exact current evidence draft');
      const evidence = draft.rawPayload as any;
      if (evidence.preparedBy === actor.toLowerCase()) throw new ForbiddenException('Independent reviewer required');
      await this.authorize(evidence.preparedBy, tx);
      if (evidence.quoteId !== meta.payoutQuote.quoteId || evidence.outcome !== outcome || evidence.transferCode !== (proof as any).transfer_code ||
          evidence.domain !== meta.domain) throw new ConflictException('Provider outcome changed; evidence requires reconciliation');
      if (draft.processed) return { draftId, approved: true, alreadyApproved: true };
      const payload = { ...evidence, reviewedBy: actor.toLowerCase(), reviewedAt: new Date().toISOString() };
      await tx.insert(schema.billingProviderEvents).values({ provider: 'paystack', reference: `internal.withdrawal.refund:${reference}`,
        eventType: 'internal.withdrawal.refund', rawPayload: payload, processed: true, processedAt: new Date() });
      await tx.update(schema.billingProviderEvents).set({ processed: true, rawPayload: payload, processedAt: new Date() }).where(eq(schema.billingProviderEvents.id, draft.id));
      // Completion remains with the ledger authority; callback or owner recovery can apply it once.
      return { draftId, approved: true, alreadyApproved: false };
    });
  }
}
