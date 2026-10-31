import { WithdrawalLedgerService } from './withdrawal-ledger.service';
import { WithdrawalDispatchService } from './withdrawal-dispatch.service';
import { WithdrawalAuthorityClient } from './withdrawal-authority.client';
import { FinancialProof } from '@crimfig/shared';
import { Injectable, Inject, NotFoundException, BadRequestException, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingWithdrawalRequests, billingBankAccounts, billingTransactions } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import { WalletService } from '../wallet/wallet.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaystackService } from '../providers/paystack.service';

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly walletService: WalletService,
    private readonly fxService: ExchangeRateService,
    private readonly paystackService: PaystackService,
    @Optional() private readonly ledger?: WithdrawalLedgerService,
    @Optional() private readonly dispatch?: WithdrawalDispatchService,
    @Optional() private readonly authority?: WithdrawalAuthorityClient,
  ) {}
  async availability() { return this.authority ? this.authority.availability() : { available: false, reason: 'security_unavailable' }; }
  async prepareAuthorization(params: { userId: string; requestId: string; quoteId: string; bankAccountId: string; amountUsd: number }) {
    this.requireAuthority();
    if (!this.authority) throw new ServiceUnavailableException('Independent withdrawal authorization is unavailable');
    const reference = this.ledger!.referenceForRequest(params.userId, params.requestId);
    const cents = Math.round(params.amountUsd * 100);
    if (!Number.isSafeInteger(cents) || cents < 500 || Math.abs(params.amountUsd * 100 - cents) > 0.0000001) throw new BadRequestException('Invalid withdrawal amount');
    const result = await this.authority.prepare({ ...params, amountUsdCents: cents });
    if (result.reference !== reference) throw new ServiceUnavailableException('Withdrawal intent identity mismatch');
    return result;
  }
  async reviewAuthorization(userId: string, reference: string, proof: FinancialProof) {
    if (!this.authority) throw new ServiceUnavailableException('Independent withdrawal authorization is unavailable');
    return this.authority.review(userId, reference, proof);
  }

  /**
   * Request a withdrawal from USD wallet to a registered NGN bank account
   */
  async requestWithdrawal(params: {
    userId: string;
    bankAccountId: string;
    amountUsd: number;
    requestId?: string;
    quoteId?: string;
    ownerProof?: FinancialProof;
  }) {
    this.requireAuthority();
    const cents = Math.round(params.amountUsd * 100);
    if (!params.requestId || !params.quoteId || !Number.isFinite(params.amountUsd) || !Number.isSafeInteger(cents) ||
        cents < 500 || cents > 2147483647 || Math.abs(params.amountUsd * 100 - cents) > 0.0000001) {
      throw new BadRequestException('Provide a UUID requestId and an amount with at most two decimal places');
    }
    if (!this.authority) throw new ServiceUnavailableException('Independent withdrawal authorization is unavailable');
    const authorityDigest = await this.authority.authorize({ userId: params.userId, requestId: params.requestId,
      bankAccountId: params.bankAccountId, amountUsdCents: cents, quoteId: params.quoteId, ownerProof: params.ownerProof });
    // Approval precedes any wallet reservation. Unknown outcomes recover by the original request ID.
    const reservation = await this.ledger!.reserve(params.userId, params.requestId, params.bankAccountId, cents, params.quoteId, authorityDigest);
    if (reservation.alreadyReserved) {
      const current = await this.ledger!.dispatchIntent(params.userId, reservation.reference, false);
      return { ...reservation, status: current.status, confirmation: 'recovery_required' };
    }
    return { ...reservation, ...await this.dispatch!.dispatch(params.userId, reservation.reference) };
  }

  async quoteWithdrawal(params: { userId: string; requestId: string; bankAccountId: string; amountUsd: number }) {
    this.requireAuthority();
    const cents = Math.round(params.amountUsd * 100);
    if (!Number.isFinite(params.amountUsd) || !Number.isSafeInteger(cents) || cents < 500 || cents > 2147483647 ||
        Math.abs(params.amountUsd * 100 - cents) > 0.0000001) throw new BadRequestException('Invalid withdrawal amount');
    return this.ledger!.quote(params.userId, params.requestId, params.bankAccountId, cents);
  }

  private requireAuthority() {
    if (!this.ledger || !this.dispatch) throw new ServiceUnavailableException('This payment operation is unavailable pending its atomic reservation, provider reconciliation and completion contract');
  }

  async recoverRequest(userId: string, requestId: string) {
    this.requireAuthority();
    return this.dispatch!.recover(userId, this.ledger!.referenceForRequest(userId, requestId));
  }

  async recoverWithdrawal(userId: string, reference: string) {
    this.requireAuthority();
    return this.dispatch!.recover(userId, reference);
  }
  async dispatchWithdrawal(userId: string, reference: string) {
    this.requireAuthority();
    return this.dispatch!.dispatch(userId, reference);
  }
  async cancelWithdrawal(userId: string, reference: string) {
    this.requireAuthority();
    return this.ledger!.cancel(userId, reference);
  }

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
    this.requireAuthority();
    return this.ledger!.registerRefundEvidence(params);
  }

  /**
   * List withdrawal requests for a user
   */
  async getUserWithdrawals(userId: string) {
    return this.db
      .select({
        id: billingWithdrawalRequests.id,
        amountUsdCents: billingWithdrawalRequests.amountUsdCents,
        amountNgnKobo: billingWithdrawalRequests.amountNgnKobo,
        status: billingWithdrawalRequests.status,
        createdAt: billingWithdrawalRequests.createdAt,
        bankAccount: {
          bankName: billingBankAccounts.bankName,
          accountNumber: billingBankAccounts.accountNumber,
          accountName: billingBankAccounts.accountName,
        },
      })
      .from(billingWithdrawalRequests)
      .leftJoin(billingBankAccounts, eq(billingWithdrawalRequests.bankAccountId, billingBankAccounts.id))
      .where(eq(billingWithdrawalRequests.userId, userId))
      .orderBy(desc(billingWithdrawalRequests.createdAt));
  }
}
