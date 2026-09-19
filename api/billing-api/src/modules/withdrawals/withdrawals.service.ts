import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
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
  ) {}

  /**
   * Request a withdrawal from USD wallet to a registered NGN bank account
   */
  async requestWithdrawal(params: {
    userId: string;
    bankAccountId: string;
    amountUsd: number;
  }) {
    if (params.amountUsd < 5) {
      throw new BadRequestException('Minimum withdrawal amount is $5.00 USD');
    }

    const usdCents = Math.round(params.amountUsd * 100);

    // 1. Verify bank account belongs to user
    const [bankAccount] = await this.db
      .select()
      .from(billingBankAccounts)
      .where(
        and(
          eq(billingBankAccounts.id, params.bankAccountId),
          eq(billingBankAccounts.userId, params.userId),
        ),
      )
      .limit(1);

    if (!bankAccount) {
      throw new NotFoundException('Selected bank account not found');
    }

    // 2. Lock USD funds in wallet
    await this.walletService.lockFunds(params.userId, usdCents, 'Withdrawal request pending');

    // 3. Get current exchange rate snapshot
    const fx = await this.fxService.getUsdToNgnRate();
    const conversion = await this.fxService.convertUsdCentsToNgn(usdCents, fx.rate);

    const reference = `crimfig_wdr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 4. Create withdrawal request record
    const [withdrawal] = await this.db
      .insert(billingWithdrawalRequests)
      .values({
        userId: params.userId,
        bankAccountId: params.bankAccountId,
        amountUsdCents: usdCents,
        amountNgnKobo: conversion.ngnKobo,
        exchangeRateId: fx.rateId,
        status: 'pending',
      })
      .returning();

    // 5. Create transaction record
    const [tx] = await this.db
      .insert(billingTransactions)
      .values({
        userId: params.userId,
        type: 'wallet_withdraw',
        status: 'pending',
        provider: 'paystack',
        reference,
        amountUsdCents: usdCents,
        amountNgnKobo: conversion.ngnKobo,
        exchangeRateId: fx.rateId,
        metadata: JSON.stringify({
          withdrawalId: withdrawal.id,
          bankAccountId: bankAccount.id,
          bankName: bankAccount.bankName,
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName,
          description: `Withdrawal $${params.amountUsd.toFixed(2)} USD (₦${conversion.ngnAmount.toLocaleString()} NGN) to ${bankAccount.bankName} - ${bankAccount.accountNumber}`,
        }),
      })
      .returning();

    // Update withdrawal with transactionId
    await this.db
      .update(billingWithdrawalRequests)
      .set({ transactionId: tx.id })
      .where(eq(billingWithdrawalRequests.id, withdrawal.id));

    // 6. Attempt automated Paystack transfer payout
    try {
      if (bankAccount.recipientCode) {
        const transferRes = await this.paystackService.initiateTransfer({
          amountKobo: conversion.ngnKobo,
          recipientCode: bankAccount.recipientCode,
          reason: `CrimFig payout ${reference}`,
          reference,
        });

        await this.db
          .update(billingWithdrawalRequests)
          .set({
            status: 'processing',
            paystackTransferCode: transferRes.transfer_code,
            paystackTransferReference: reference,
            updatedAt: new Date(),
          })
          .where(eq(billingWithdrawalRequests.id, withdrawal.id));
      }
    } catch (err: any) {
      this.logger.warn(`Automated Paystack transfer queued for manual / retry: ${err.message}`);
    }

    return {
      status: 'pending',
      withdrawalId: withdrawal.id,
      amountUsd: params.amountUsd,
      amountNgn: conversion.ngnAmount,
      exchangeRate: fx.rate,
      bankAccount: {
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
        accountName: bankAccount.accountName,
      },
    };
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
