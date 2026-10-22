import { WithdrawalLedgerService } from './withdrawal-ledger.service';
import { WithdrawalDispatchService } from './withdrawal-dispatch.service';
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
  ) {}

  /**
   * Request a withdrawal from USD wallet to a registered NGN bank account
   */
  async requestWithdrawal(params: {
    userId: string;
    bankAccountId: string;
    amountUsd: number;
    requestId?: string;
    quoteId?: string;
  }) {
    this.requireAuthority();
    const cents = Math.round(params.amountUsd * 100);
    if (!params.requestId || !params.quoteId || !Number.isFinite(params.amountUsd) || !Number.isSafeInteger(cents) ||
        cents < 500 || cents > 2147483647 || Math.abs(params.amountUsd * 100 - cents) > 0.0000001) {
      throw new BadRequestException('Provide a UUID requestId and an amount with at most two decimal places');
    }
    // Reservation uses an existing validated quote; repeats never require a new provider/FX request.
    const reservation = await this.ledger!.reserve(params.userId, params.requestId, params.bankAccountId, cents, params.quoteId);
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
