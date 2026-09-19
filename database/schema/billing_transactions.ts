import { pgTable, uuid, integer, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { billingExchangeRates } from './billing_exchange_rates';

/**
 * billing_transactions
 *
 * APPEND-ONLY immutable ledger. Every financial event creates a new row.
 * No UPDATE or DELETE is ever issued on amount_usd_cents, exchange_rate_id, or reference.
 *
 * amount_usd_cents: The USD value of this transaction (always positive).
 * amount_ngn_kobo:  The NGN value at time of transaction (funding/withdrawal only).
 * exchange_rate_id: FK to the exact rate row used — immutable audit link.
 *
 * Direction of flow is determined by `type`:
 *   - wallet_fund, ads_earning, rewards_credit → credits (positive)
 *   - wallet_withdraw, ads_spend, subscription_charge → debits (positive amount, negative effect on wallet)
 */
export const transactionTypeEnum = pgEnum('billing_transaction_type', [
  'wallet_fund',
  'wallet_withdraw',
  'subscription_charge',
  'subscription_renewal',
  'one_time_payment',
  'ads_spend',
  'ads_earning',
  'rewards_credit',
  'internal_debit',
  'internal_credit',
  'reversal',
]);

export const transactionStatusEnum = pgEnum('billing_transaction_status', [
  'pending',
  'completed',
  'failed',
  'reversed',
  'refunded',
]);

export const billingTransactions = pgTable(
  'billing_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

    type: transactionTypeEnum('type').notNull(),
    status: transactionStatusEnum('status').notNull().default('pending'),

    // All monetary amounts as integer cents (never floats)
    amountUsdCents: integer('amount_usd_cents').notNull(),

    // NGN amount at the moment of the transaction (funding/withdrawal only, null for internal)
    amountNgnKobo: integer('amount_ngn_kobo'),

    // FK to the exact exchange rate snapshot used — permanently linked
    exchangeRateId: uuid('exchange_rate_id').references(() => billingExchangeRates.id),

    // PSP payment reference (Paystack reference, Stripe session ID, etc.)
    reference: text('reference').unique(),

    // Internal idempotency key for ecosystem API calls
    idempotencyKey: text('idempotency_key').unique(),

    provider: text('provider'),  // paystack | stripe | internal

    // JSONB metadata: context-specific (subscription plan, campaign ID, etc.)
    metadata: text('metadata'),  // JSON string for portability

    // Set on failure for display in transaction history
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_transactions_user_id_idx').on(t.userId),
    index('billing_transactions_type_idx').on(t.type),
    index('billing_transactions_status_idx').on(t.status),
    index('billing_transactions_created_at_idx').on(t.createdAt),
    index('billing_transactions_reference_idx').on(t.reference),
  ],
);

export type BillingTransaction = typeof billingTransactions.$inferSelect;
export type NewBillingTransaction = typeof billingTransactions.$inferInsert;
