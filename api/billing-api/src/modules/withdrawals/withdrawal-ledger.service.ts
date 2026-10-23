import { randomUUID } from 'crypto';
import { netWithdrawalQuote, withdrawalRefundCents, WITHDRAWAL_FEE_POLICY, WITHDRAWAL_REFUND_POLICY } from './withdrawal-fees';
import { createHash } from 'crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingBankAccounts, billingTransactions, billingWallets, billingWithdrawalRequests } from '@crimfig/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaystackService } from '../providers/paystack.service';
import { verifiedTransferOutcome, withdrawalBalances, withdrawalTransition } from './withdrawal-state';

/** Atomic completion authority for version-2 reserved withdrawals. Not a public/provider entry point.
 * Caller must authenticate provider evidence before calling. Never adopt historical unreceipted rows.
 * Reservation/dispatch/reconciliation and webhook integration must be verified before activation.
 */
@Injectable()
export class WithdrawalLedgerService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystack: PaystackService, private readonly fx: ExchangeRateService) {}

  referenceForRequest(userId: string, requestId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new ConflictException('Invalid withdrawal request identity');
    }
    return 'wd_' + createHash('sha256').update(userId + ':' + requestId.toLowerCase()).digest('hex').slice(0, 40);
  }

  /** Durable server quote in a reserved internal event/reference namespace.
   * The webhook dispatcher only accepts charge.success and transfer.*; it cannot write this namespace. */
  async quote(userId: string, requestId: string, bankAccountId: string, cents: number) {
    const reference = this.referenceForRequest(userId, requestId);
    if (!Number.isSafeInteger(cents) || cents < 500 || cents > 2147483647) throw new ConflictException('Invalid withdrawal amount');
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
      const [existing] = await tx.select().from(schema.billingProviderEvents).where(and(
        eq(schema.billingProviderEvents.provider, 'paystack'), eq(schema.billingProviderEvents.reference, `internal.withdrawal.quote:${reference}`), eq(schema.billingProviderEvents.eventType, 'internal.withdrawal.quote')));
      if (existing) {
        const prior = existing.rawPayload as any;
        if (prior?.userId !== userId || prior.bankAccountId !== bankAccountId || prior.amountUsdCents !== cents ||
            prior.domain !== this.paystack.paymentDomain() || prior.policy !== WITHDRAWAL_FEE_POLICY || !Number.isFinite(Date.parse(prior.expiresAt)) || Date.parse(prior.expiresAt) <= Date.now()) {
          throw new ConflictException('Quote expired or details changed; request a new quote with a new requestId');
        }
        return prior;
      }
      const [owner] = await tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId));
      const [bank] = await tx.select().from(billingBankAccounts).where(and(eq(billingBankAccounts.id, bankAccountId), eq(billingBankAccounts.userId, userId)));
      if (owner?.status !== 'ACTIVE' || !bank?.isVerified || !bank.recipientCode) throw new ConflictException('A verified owned recipient and active account are required');
      const [rate] = await tx.select().from(schema.billingExchangeRates).orderBy(sql`${schema.billingExchangeRates.fetchedAt} desc`).limit(1);
      const fx = this.fx.validateStoredRate(rate);
      const grossKobo = Number((BigInt(cents) * BigInt(fx.rate.toFixed(6).replace('.', '')) + 500000n) / 1000000n);
      let charges; try { charges = netWithdrawalQuote(grossKobo); } catch { throw new ConflictException('Choose another withdrawal amount; a positive exact net quote is unavailable at this fee boundary'); }
      const quote = { ...charges, refundPolicy: WITHDRAWAL_REFUND_POLICY, quoteId: randomUUID(), reference, requestId: requestId.toLowerCase(),
        userId, bankAccountId, recipientCode: bank.recipientCode, amountUsdCents: cents, rateId: rate.id, rate: fx.rate,
        domain: this.paystack.paymentDomain(), expiresAt: new Date(Date.now() + 300000).toISOString() };
      await tx.insert(schema.billingProviderEvents).values({ provider: 'paystack', reference: `internal.withdrawal.quote:${reference}`,
        eventType: 'internal.withdrawal.quote', rawPayload: quote, processed: true, processedAt: new Date() });
      return quote;
    });
  }

  async reserve(userId: string, requestId: string, bankAccountId: string, cents: number, confirmedQuoteId?: string) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const identity = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!identity.test(userId) || !uuid.test(requestId) || !identity.test(bankAccountId) ||
        !Number.isSafeInteger(cents) || cents < 500 || cents > 2147483647) throw new ConflictException('Invalid withdrawal request');
    const reference = this.referenceForRequest(userId, requestId);
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
      const [existing] = await tx.select().from(billingTransactions).where(eq(billingTransactions.reference, reference)).for('update');
      if (existing) {
        let metadata: any; try { metadata = JSON.parse(existing.metadata || '{}'); } catch { metadata = {}; }
        if (existing.userId !== userId || existing.type !== 'wallet_withdraw' || existing.provider !== 'paystack' ||
            existing.amountUsdCents !== cents || metadata.withdrawalVersion !== 2 ||
            metadata.bankAccountId !== bankAccountId || metadata.domain !== this.paystack.paymentDomain() ||
            (confirmedQuoteId && metadata.payoutQuote?.quoteId !== confirmedQuoteId)) {
          throw new ConflictException('Withdrawal request is already bound to different details');
        }
        const [prior] = await tx.select().from(billingWithdrawalRequests).where(eq(billingWithdrawalRequests.transactionId, existing.id));
        if (!prior) throw new ConflictException('Withdrawal reservation requires reconciliation');
        return { withdrawalId: prior.id, reference, status: prior.status, alreadyReserved: true };
      }
      let confirmedQuote: any;
      if (confirmedQuoteId) {
        const [record] = await tx.select().from(schema.billingProviderEvents).where(and(
          eq(schema.billingProviderEvents.provider, 'paystack'), eq(schema.billingProviderEvents.reference, `internal.withdrawal.quote:${reference}`), eq(schema.billingProviderEvents.eventType, 'internal.withdrawal.quote')));
        confirmedQuote = record?.rawPayload;
        if (!confirmedQuote || confirmedQuote.quoteId !== confirmedQuoteId || confirmedQuote.userId !== userId ||
            confirmedQuote.bankAccountId !== bankAccountId || confirmedQuote.amountUsdCents !== cents ||
            confirmedQuote.domain !== this.paystack.paymentDomain() || confirmedQuote.policy !== WITHDRAWAL_FEE_POLICY ||
            !Number.isFinite(Date.parse(confirmedQuote.expiresAt)) || Date.parse(confirmedQuote.expiresAt) <= Date.now()) {
          throw new ConflictException('A current matching payout quote must be confirmed');
        }
      }
      const [owner] = await tx.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
      if (owner?.status !== 'ACTIVE') throw new ConflictException('Account unavailable for withdrawal');
      const [bank] = await tx.select().from(billingBankAccounts).where(and(eq(billingBankAccounts.id, bankAccountId),
        eq(billingBankAccounts.userId, userId))).for('update');
      if (!bank?.isVerified || !/^RCP_[A-Za-z0-9]+$/.test(bank.recipientCode || '')) throw new ConflictException('A verified owned recipient is required');
      if (confirmedQuote && confirmedQuote.recipientCode !== bank.recipientCode) throw new ConflictException('Recipient changed; review a new payout quote');
      // Only persisted, validated FX is read; never perform provider/FX network calls inside this transaction.
      const [rate] = confirmedQuote ? await tx.select().from(schema.billingExchangeRates).where(eq(schema.billingExchangeRates.id, confirmedQuote.rateId)).limit(1) :
        await tx.select().from(schema.billingExchangeRates).orderBy(sql`${schema.billingExchangeRates.fetchedAt} desc`).limit(1);
      const quote = this.fx.validateStoredRate(rate);
      const scaledRate = BigInt(quote.rate.toFixed(6).replace('.', ''));
      const grossKobo = Number((BigInt(cents) * scaledRate + 500000n) / 1000000n);
      if (confirmedQuote) {
        const recalculated = netWithdrawalQuote(grossKobo);
        if (recalculated.netKobo !== confirmedQuote.netKobo || recalculated.totalFeeKobo !== confirmedQuote.totalFeeKobo ||
            grossKobo !== confirmedQuote.grossKobo) throw new ConflictException('Payout quote requires reconciliation');
      }
      const amountKobo = confirmedQuote ? confirmedQuote.netKobo : grossKobo;
      if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0 || amountKobo > 2147483647) throw new ConflictException('Withdrawal quote exceeds supported amount');
      const [wallet] = await tx.select().from(billingWallets).where(eq(billingWallets.userId, userId)).for('update');
      if (!wallet || wallet.balanceUsdCents < cents) throw new ConflictException('Insufficient available balance');
      const balances = withdrawalBalances(wallet.balanceUsdCents, wallet.lockedUsdCents, { availableDelta: -cents, lockedDelta: cents });
      const [intent] = await tx.insert(billingTransactions).values({ userId, type: 'wallet_withdraw', status: 'pending',
        amountUsdCents: cents, amountNgnKobo: amountKobo, exchangeRateId: rate.id, provider: 'paystack', reference,
        balanceBeforeUsdCents: wallet.balanceUsdCents, balanceAfterUsdCents: balances.available,
        metadata: JSON.stringify({ withdrawalVersion: 2, requestId: requestId.toLowerCase(), bankAccountId,
          recipientCode: bank.recipientCode, domain: this.paystack.paymentDomain(), dispatch: 'not_started',
          ...(confirmedQuote ? { payoutQuote: confirmedQuote } : {}) }) }).returning();
      const [withdrawal] = await tx.insert(billingWithdrawalRequests).values({ userId, bankAccountId,
        amountUsdCents: cents, amountNgnKobo: amountKobo, exchangeRateId: rate.id,
        transactionId: intent.id, paystackTransferReference: reference, status: 'pending' }).returning();
      await tx.update(billingWallets).set({ balanceUsdCents: balances.available, lockedUsdCents: balances.locked,
        version: wallet.version + 1, updatedAt: new Date() }).where(eq(billingWallets.id, wallet.id));
      return { withdrawalId: withdrawal.id, reference, status: withdrawal.status, alreadyReserved: false };
    });
  }

  /** Commit dispatch ownership before any provider call. A started request is never auto-replayed. */
  async dispatchIntent(userId: string, reference: string, start: boolean) {
    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
      const [intent] = await tx.select().from(billingTransactions).where(and(eq(billingTransactions.reference, reference),
        eq(billingTransactions.userId, userId))).for('update');
      if (!intent) throw new NotFoundException('Withdrawal not found');
      let metadata: any; try { metadata = JSON.parse(intent.metadata || '{}'); } catch { metadata = {}; }
      if (intent.type !== 'wallet_withdraw' || intent.provider !== 'paystack' || metadata.withdrawalVersion !== 2 ||
          metadata.domain !== this.paystack.paymentDomain() || !/^RCP_[A-Za-z0-9]+$/.test(metadata.recipientCode || '') ||
          !Number.isSafeInteger(intent.amountNgnKobo) || intent.amountNgnKobo! <= 0 ||
          !['not_started', 'started'].includes(metadata.dispatch)) throw new ConflictException('Withdrawal requires reconciliation');
      const [withdrawal] = await tx.select().from(billingWithdrawalRequests).where(and(
        eq(billingWithdrawalRequests.transactionId, intent.id), eq(billingWithdrawalRequests.userId, userId),
        eq(billingWithdrawalRequests.paystackTransferReference, reference))).for('update');
      if (!withdrawal || withdrawal.amountUsdCents !== intent.amountUsdCents || withdrawal.amountNgnKobo !== intent.amountNgnKobo ||
          withdrawal.bankAccountId !== metadata.bankAccountId || withdrawal.exchangeRateId !== intent.exchangeRateId) {
        throw new ConflictException('Withdrawal reservation requires reconciliation');
      }
      let claimed = false;
      if (start && metadata.dispatch === 'not_started' && intent.status === 'pending' && withdrawal.status === 'pending') {
        const [owner] = await tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).for('update');
        if (owner?.status !== 'ACTIVE') throw new ConflictException('Account unavailable for withdrawal');
        const [bank] = await tx.select().from(billingBankAccounts).where(and(eq(billingBankAccounts.id, withdrawal.bankAccountId),
          eq(billingBankAccounts.userId, userId))).for('update');
        if (!bank?.isVerified || bank.recipientCode !== metadata.recipientCode) throw new ConflictException('Reserved recipient requires reconciliation');
        metadata.dispatch = 'started'; metadata.dispatchStartedAt = new Date().toISOString();
        await tx.update(billingTransactions).set({ metadata: JSON.stringify(metadata), updatedAt: new Date() }).where(eq(billingTransactions.id, intent.id));
        await tx.update(billingWithdrawalRequests).set({ status: 'processing', updatedAt: new Date() }).where(eq(billingWithdrawalRequests.id, withdrawal.id));
        claimed = true;
      }
      const reconciliation = metadata.refundReconciliation;
      let refund: { grossUsdCents: number; refundUsdCents: number; retainedUsdCents: number; retainedKobo: number } | undefined;
      if (reconciliation && ['failed', 'reversed'].includes(withdrawal.status)) {
        if (![reconciliation.refundUsdCents, reconciliation.retainedUsdCents, reconciliation.retainedKobo]
          .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647) ||
          reconciliation.refundUsdCents + reconciliation.retainedUsdCents !== intent.amountUsdCents) throw new ConflictException('Refund receipt requires reconciliation');
        refund = { grossUsdCents: intent.amountUsdCents, refundUsdCents: reconciliation.refundUsdCents,
          retainedUsdCents: reconciliation.retainedUsdCents, retainedKobo: reconciliation.retainedKobo };
      }
      return { claimed, userId, reference, withdrawalId: withdrawal.id, status: claimed ? 'processing' : withdrawal.status,
        amountKobo: intent.amountNgnKobo!, recipientCode: metadata.recipientCode as string,
        domain: metadata.domain as 'test' | 'live', transferCode: withdrawal.paystackTransferCode,
        dispatchStarted: metadata.dispatch === 'started', refund };
    });
  }

  /** Only a provably undispatched intent can be cancelled/refunded without provider evidence. */
  async cancel(userId: string, reference: string) {
    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) throw new NotFoundException('Withdrawal not found');
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
      const [intent] = await tx.select().from(billingTransactions).where(and(eq(billingTransactions.reference, reference),
        eq(billingTransactions.userId, userId))).for('update');
      if (!intent) throw new NotFoundException('Withdrawal not found');
      let metadata: any; try { metadata = JSON.parse(intent.metadata || '{}'); } catch { metadata = {}; }
      if (intent.type !== 'wallet_withdraw' || intent.provider !== 'paystack' || metadata.withdrawalVersion !== 2 ||
          metadata.domain !== this.paystack.paymentDomain() || metadata.dispatch !== 'not_started') {
        throw new ConflictException('Dispatched or historical withdrawal requires provider reconciliation');
      }
      const [withdrawal] = await tx.select().from(billingWithdrawalRequests).where(and(
        eq(billingWithdrawalRequests.transactionId, intent.id), eq(billingWithdrawalRequests.userId, userId),
        eq(billingWithdrawalRequests.paystackTransferReference, reference))).for('update');
      if (!withdrawal || withdrawal.amountUsdCents !== intent.amountUsdCents || withdrawal.amountNgnKobo !== intent.amountNgnKobo ||
          withdrawal.bankAccountId !== metadata.bankAccountId || withdrawal.exchangeRateId !== intent.exchangeRateId) {
        throw new ConflictException('Withdrawal reservation requires reconciliation');
      }
      if (withdrawal.status === 'cancelled' && intent.status === 'failed' && metadata.cancelled === true) {
        return { withdrawalId: withdrawal.id, reference, status: 'cancelled', alreadyCancelled: true };
      }
      if (withdrawal.status !== 'pending' || intent.status !== 'pending') throw new ConflictException('Withdrawal cannot be cancelled');
      const [wallet] = await tx.select().from(billingWallets).where(eq(billingWallets.userId, userId)).for('update');
      if (!wallet) throw new ConflictException('Withdrawal wallet unavailable');
      const balances = withdrawalBalances(wallet.balanceUsdCents, wallet.lockedUsdCents,
        withdrawalTransition('pending', 'failed', intent.amountUsdCents));
      await tx.update(billingWallets).set({ balanceUsdCents: balances.available, lockedUsdCents: balances.locked,
        version: wallet.version + 1, updatedAt: new Date() }).where(eq(billingWallets.id, wallet.id));
      await tx.update(billingWithdrawalRequests).set({ status: 'cancelled', updatedAt: new Date(), processedAt: new Date() })
        .where(eq(billingWithdrawalRequests.id, withdrawal.id));
      await tx.update(billingTransactions).set({ status: 'failed', failureReason: 'Cancelled before provider dispatch',
        balanceAfterUsdCents: balances.available, updatedAt: new Date(), metadata: JSON.stringify({ ...metadata, cancelled: true }) })
        .where(eq(billingTransactions.id, intent.id));
      return { withdrawalId: withdrawal.id, reference, status: 'cancelled', alreadyCancelled: false };
    });
  }

  async complete(reference: string, data: unknown) {
    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) throw new ConflictException('Invalid transfer reference');
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);
      const [intent] = await tx.select().from(billingTransactions).where(and(
        eq(billingTransactions.reference, reference), eq(billingTransactions.provider, 'paystack'))).for('update');
      if (!intent) throw new NotFoundException('Reserved withdrawal not found');
      let metadata: any;
      try { metadata = JSON.parse(intent.metadata || '{}'); } catch { metadata = {}; }
      if (intent.type !== 'wallet_withdraw' || metadata.withdrawalVersion !== 2 ||
          metadata.domain !== this.paystack.paymentDomain() || typeof metadata.recipientCode !== 'string') {
        throw new ConflictException('Withdrawal requires historical/provider reconciliation');
      }
      const [withdrawal] = await tx.select().from(billingWithdrawalRequests).where(and(
        eq(billingWithdrawalRequests.transactionId, intent.id), eq(billingWithdrawalRequests.userId, intent.userId),
        eq(billingWithdrawalRequests.paystackTransferReference, reference))).for('update');
      if (!withdrawal || withdrawal.amountUsdCents !== intent.amountUsdCents ||
          withdrawal.amountNgnKobo !== intent.amountNgnKobo || withdrawal.exchangeRateId !== intent.exchangeRateId ||
          withdrawal.bankAccountId !== metadata.bankAccountId ||
          !Number.isInteger(intent.amountUsdCents) || intent.amountUsdCents <= 0) {
        throw new ConflictException('Withdrawal reservation does not match its receipt');
      }
      const expectedStatus = withdrawal.status === 'completed' ? 'completed' : withdrawal.status === 'failed' ? 'failed' :
        withdrawal.status === 'reversed' ? 'reversed' : 'pending';
      if (intent.status !== expectedStatus) throw new ConflictException('Withdrawal status requires reconciliation');
      let transition;
      let refundReconciliation: any;
      try {
        const outcome = verifiedTransferOutcome({ reference, amountKobo: withdrawal.amountNgnKobo,
          recipientCode: metadata.recipientCode, domain: metadata.domain, transferCode: withdrawal.paystackTransferCode }, data);
        transition = withdrawalTransition(withdrawal.status, outcome, withdrawal.amountUsdCents);
        if (metadata.payoutQuote && outcome !== 'success' && transition.changed) {
          // Only an internal, separately reviewed provider-evidence receipt can authorize fee deductions.
          // Public callbacks cannot create this namespace; absence is not proof of zero retained cost.
          const [record] = await tx.select().from(schema.billingProviderEvents).where(and(
            eq(schema.billingProviderEvents.provider, 'paystack'),
            eq(schema.billingProviderEvents.reference, `internal.withdrawal.refund:${reference}`),
            eq(schema.billingProviderEvents.eventType, 'internal.withdrawal.refund')));
          const evidence = record?.rawPayload as any;
          const payout = metadata.payoutQuote;
          const proof = data as { transfer_code: string };
          if (!record?.processed || evidence?.version !== 2 || evidence.reviewKind !== 'independent-authenticated-operators' || evidence.reference !== reference ||
              evidence.domain !== metadata.domain || evidence.currency !== 'NGN' ||
              evidence.transferCode !== proof.transfer_code || !['failed', 'reversed'].includes(evidence.outcome) ||
              evidence.outcome !== outcome || evidence.quoteId !== payout.quoteId ||
              typeof evidence.providerEvidenceId !== 'string' || !evidence.providerEvidenceId.trim() ||
              typeof evidence.preparedBy !== 'string' || typeof evidence.reviewedBy !== 'string' ||
              !evidence.preparedBy || !evidence.reviewedBy || evidence.preparedBy === evidence.reviewedBy ||
              !Number.isSafeInteger(evidence.retainedFeeKobo) || evidence.retainedFeeKobo < 0 || evidence.retainedFeeKobo > payout.transferFeeKobo ||
              !Number.isSafeInteger(evidence.retainedStampDutyKobo) || evidence.retainedStampDutyKobo < 0 || evidence.retainedStampDutyKobo > payout.stampDutyKobo) {
            throw new Error('Confirmed retained provider charges require reconciliation');
          }
          const retainedKobo = evidence.retainedFeeKobo + evidence.retainedStampDutyKobo;
          const refund = withdrawalRefundCents(withdrawal.amountUsdCents, payout.rate, retainedKobo, payout.totalFeeKobo);
          refundReconciliation = { policy: WITHDRAWAL_REFUND_POLICY, evidenceId: record.id,
            retainedKobo, ...refund };
          if (metadata.refundReconciliation && (metadata.refundReconciliation.retainedKobo !== retainedKobo ||
              metadata.refundReconciliation.refundUsdCents !== refund.refundUsdCents)) throw new Error('Refund evidence changed after settlement');
          if (transition.availableDelta > 0) transition.availableDelta = refund.refundUsdCents;
        }
      } catch { throw new ConflictException('Provider outcome does not match this withdrawal'); }
      if (!transition.changed) return { withdrawalId: withdrawal.id, status: withdrawal.status, alreadyCompleted: true };
      const [wallet] = await tx.select().from(billingWallets).where(eq(billingWallets.userId, intent.userId)).for('update');
      if (!wallet) throw new ConflictException('Withdrawal wallet unavailable');
      let balances;
      try { balances = withdrawalBalances(wallet.balanceUsdCents, wallet.lockedUsdCents, transition); }
      catch { throw new ConflictException('Withdrawal wallet requires reconciliation'); }
      await tx.update(billingWallets).set({ balanceUsdCents: balances.available, lockedUsdCents: balances.locked,
        version: wallet.version + 1, updatedAt: new Date() }).where(eq(billingWallets.id, wallet.id));
      const proof = data as { transfer_code: string };
      await tx.update(billingWithdrawalRequests).set({ status: transition.status,
        paystackTransferCode: proof.transfer_code, processedAt: new Date(), updatedAt: new Date() })
        .where(eq(billingWithdrawalRequests.id, withdrawal.id));
      await tx.update(billingTransactions).set({ status: transition.status as 'completed' | 'failed' | 'reversed',
        balanceAfterUsdCents: balances.available, updatedAt: new Date(),
        metadata: JSON.stringify({ ...metadata, ...(refundReconciliation ? { refundReconciliation } : {}), terminalStatus: transition.status,
          terminalAvailableDelta: transition.availableDelta, terminalLockedDelta: transition.lockedDelta }) })
        .where(eq(billingTransactions.id, intent.id));
      return { withdrawalId: withdrawal.id, status: transition.status, alreadyCompleted: false };
    });
  }

  /**
   * Internal/Operator authority to register verified provider evidence receipts
   * for failed or reversed withdrawal fee reconciliation.
   * Requires two distinct reviewers, nonnegative kobo bounded by quoted fees, matching transfer code and domain.
   */
  async registerRefundEvidence(params: {
    reference: string;
    transferCode: string;
    outcome: 'failed' | 'reversed';
    providerEvidenceId: string;
    preparedBy: string;
    reviewedBy: string;
    retainedFeeKobo: number;
    retainedStampDutyKobo: number;
  }) {
    const { reference, transferCode, outcome, providerEvidenceId, preparedBy, reviewedBy, retainedFeeKobo, retainedStampDutyKobo } = params;
    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) throw new ConflictException('Invalid transfer reference');
    if (!['failed', 'reversed'].includes(outcome)) throw new ConflictException('Invalid refund outcome');
    if (typeof providerEvidenceId !== 'string' || !providerEvidenceId.trim()) throw new ConflictException('Valid providerEvidenceId is required');
    if (typeof preparedBy !== 'string' || !preparedBy.trim() || typeof reviewedBy !== 'string' || !reviewedBy.trim() || preparedBy.trim() === reviewedBy.trim()) {
      throw new ConflictException('Dual distinct operators (preparedBy and reviewedBy) are required');
    }
    if (!Number.isSafeInteger(retainedFeeKobo) || retainedFeeKobo < 0 || !Number.isSafeInteger(retainedStampDutyKobo) || retainedStampDutyKobo < 0) {
      throw new ConflictException('Retained charges must be non-negative safe integers in kobo');
    }

    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withdrawal:${reference}`}, 0))`);

      const [intent] = await tx.select().from(billingTransactions).where(and(
        eq(billingTransactions.reference, reference), eq(billingTransactions.provider, 'paystack'))).for('update');
      if (!intent) throw new NotFoundException('Reserved withdrawal not found');

      let metadata: any;
      try { metadata = JSON.parse(intent.metadata || '{}'); } catch { metadata = {}; }
      if (intent.type !== 'wallet_withdraw' || metadata.withdrawalVersion !== 2 ||
          metadata.domain !== this.paystack.paymentDomain() || !metadata.payoutQuote) {
        throw new ConflictException('Withdrawal does not have an active quote or requires domain reconciliation');
      }

      const payout = metadata.payoutQuote;
      if (retainedFeeKobo > payout.transferFeeKobo || retainedStampDutyKobo > payout.stampDutyKobo) {
        throw new ConflictException('Retained charges exceed quoted limits');
      }

      const eventRef = `internal.withdrawal.refund:${reference}`;
      const [existing] = await tx.select().from(schema.billingProviderEvents).where(and(
        eq(schema.billingProviderEvents.provider, 'paystack'),
        eq(schema.billingProviderEvents.reference, eventRef),
        eq(schema.billingProviderEvents.eventType, 'internal.withdrawal.refund'))).for('update');

      if (existing) {
        const prior = existing.rawPayload as any;
        if (prior?.version === 1 && prior?.transferCode === transferCode && prior?.outcome === outcome &&
            prior?.quoteId === payout.quoteId && prior?.retainedFeeKobo === retainedFeeKobo &&
            prior?.retainedStampDutyKobo === retainedStampDutyKobo && prior?.providerEvidenceId === providerEvidenceId.trim()) {
          return { reference, evidenceId: existing.id, alreadyRegistered: true };
        }
        throw new ConflictException('Refund evidence is already registered with differing details; requires operator audit');
      }

      const rawPayload = {
        version: 1,
        reference,
        domain: metadata.domain,
        currency: 'NGN',
        transferCode,
        outcome,
        quoteId: payout.quoteId,
        providerEvidenceId: providerEvidenceId.trim(),
        preparedBy: preparedBy.trim(),
        reviewedBy: reviewedBy.trim(),
        retainedFeeKobo,
        retainedStampDutyKobo,
        registeredAt: new Date().toISOString(),
      };

      const [inserted] = await tx.insert(schema.billingProviderEvents).values({
        provider: 'paystack',
        reference: eventRef,
        eventType: 'internal.withdrawal.refund',
        rawPayload,
        processed: true,
        processedAt: new Date(),
      }).returning();

      return { reference, evidenceId: inserted.id, alreadyRegistered: false };
    });
  }
}
