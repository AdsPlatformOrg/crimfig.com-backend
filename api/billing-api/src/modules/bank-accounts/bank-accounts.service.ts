import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingBankAccounts } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import { PaystackService } from '../providers/paystack.service';

@Injectable()
export class BankAccountsService {
  private readonly logger = new Logger(BankAccountsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystackService: PaystackService,
  ) {}

  /**
   * List all Nigerian banks supported by Paystack
   */
  async listBanks() {
    return this.paystackService.listBanks();
  }

  /**
   * Verify NUBAN account number against bank code
   */
  async resolveAccount(accountNumber: string, bankCode: string) {
    return this.paystackService.resolveAccount(accountNumber, bankCode);
  }

  /**
   * Add a verified bank account for withdrawals
   */
  async addBankAccount(params: {
    userId: string;
    accountNumber: string;
    bankCode: string;
    bankName: string;
  }) {
    // 1. Resolve name via Paystack
    const resolved = await this.paystackService.resolveAccount(params.accountNumber, params.bankCode);

    // 2. Create Paystack transfer recipient
    const recipient = await this.paystackService.createTransferRecipient({
      name: resolved.account_name,
      accountNumber: params.accountNumber,
      bankCode: params.bankCode,
    });

    // 3. Save to database
    const [existing] = await this.db
      .select()
      .from(billingBankAccounts)
      .where(
        and(
          eq(billingBankAccounts.userId, params.userId),
          eq(billingBankAccounts.accountNumber, params.accountNumber),
          eq(billingBankAccounts.bankCode, params.bankCode),
        ),
      )
      .limit(1);

    if (existing) {
      const [reactivated] = await this.db
        .update(billingBankAccounts)
        .set({
          accountName: resolved.account_name,
          recipientCode: recipient.recipient_code,
          isVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(billingBankAccounts.id, existing.id))
        .returning();

      return reactivated;
    }

    const [saved] = await this.db
      .insert(billingBankAccounts)
      .values({
        userId: params.userId,
        accountNumber: params.accountNumber,
        accountName: resolved.account_name,
        bankCode: params.bankCode,
        bankName: params.bankName,
        recipientCode: recipient.recipient_code,
        isVerified: true,
        isDefault: false,
      })
      .returning();

    return saved;
  }

  /**
   * Get all verified bank accounts for a user
   */
  async getUserBankAccounts(userId: string) {
    return this.db
      .select()
      .from(billingBankAccounts)
      .where(eq(billingBankAccounts.userId, userId))
      .orderBy(desc(billingBankAccounts.isDefault), desc(billingBankAccounts.createdAt));
  }

  /**
   * Delete a bank account
   */
  async deleteBankAccount(userId: string, id: string) {
    const [account] = await this.db
      .select()
      .from(billingBankAccounts)
      .where(and(eq(billingBankAccounts.id, id), eq(billingBankAccounts.userId, userId)))
      .limit(1);

    if (!account) {
      throw new NotFoundException('Bank account not found');
    }

    await this.db
      .delete(billingBankAccounts)
      .where(eq(billingBankAccounts.id, id));

    return { message: 'Bank account removed' };
  }
}
