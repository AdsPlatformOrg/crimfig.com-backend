import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { billingBankAccounts } from './billing_bank_accounts';
import { billingExchangeRates } from './billing_exchange_rates';
import { billingTransactions } from './billing_transactions';

/**
 * billing_withdrawal_requests
 *
 * State machine for withdrawal operations.
 *
 * States:
 *   pending      → initiated, Paystack transfer not yet created
 *   processing   → Paystack transfer created (transfer_code obtained)
 *   completed    → transfer.success webhook received
 *   failed       → transfer.failed webhook received → funds returned to wallet
 *   reversed     → transfer.reversed webhook received → funds returned to wallet
 *   cancelled    → user cancelled before Paystack transfer was initiated
 *
 * Funds flow:
 *   On initiate → wallet.locked_usd_cents += amount (funds reserved)
 *   On completed → wallet.locked_usd_cents -= amount (funds deducted permanently)
 *   On failed/reversed → wallet.locked_usd_cents -= amount; wallet.balance_usd_cents += amount (refunded)
 */
export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'reversed',
  'cancelled',
]);

export const billingWithdrawalRequests = pgTable(
  'billing_withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

    // Amount the user requested to withdraw (in USD cents)
    amountUsdCents: integer('amount_usd_cents').notNull(),

    // NGN amount that will be transferred (calculated at initiation time)
    amountNgnKobo: integer('amount_ngn_kobo').notNull(),

    // Rate used for this withdrawal — locked at initiation
    exchangeRateId: uuid('exchange_rate_id').notNull().references(() => billingExchangeRates.id),

    // Bank account to send to
    bankAccountId: uuid('bank_account_id').notNull().references(() => billingBankAccounts.id),

    status: withdrawalStatusEnum('status').notNull().default('pending'),

    // Paystack Transfer codes (set once transfer is initiated)
    paystackTransferCode: text('paystack_transfer_code'),
    paystackTransferReference: text('paystack_transfer_reference').unique(),

    // Linked billing transaction ID
    transactionId: uuid('transaction_id').references(() => billingTransactions.id),

    failureReason: text('failure_reason'),

    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_withdrawals_user_id_idx').on(t.userId),
    index('billing_withdrawals_status_idx').on(t.status),
  ],
);

export type BillingWithdrawalRequest = typeof billingWithdrawalRequests.$inferSelect;
export type NewBillingWithdrawalRequest = typeof billingWithdrawalRequests.$inferInsert;
