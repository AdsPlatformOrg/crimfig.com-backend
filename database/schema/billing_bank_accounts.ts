import { pgTable, uuid, varchar, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * billing_bank_accounts
 *
 * Bank accounts registered for NGN withdrawals via Paystack Transfer.
 * recipient_code is the Paystack Transfer Recipient code (TRF_...) which is
 * created by calling POST /transferrecipient when the bank account is added.
 *
 * account_name is verified via Paystack /bank/resolve before saving.
 * This prevents users from entering wrong account details.
 */
export const billingBankAccounts = pgTable(
  'billing_bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    bankName: varchar('bank_name', { length: 100 }).notNull(),
    bankCode: varchar('bank_code', { length: 10 }).notNull(),   // Paystack bank code
    accountNumber: varchar('account_number', { length: 20 }).notNull(),
    accountName: varchar('account_name', { length: 255 }).notNull(), // verified by Paystack

    // Paystack Transfer Recipient code — required to initiate transfers
    recipientCode: varchar('recipient_code', { length: 50 }),

    isDefault: boolean('is_default').notNull().default(false),
    isVerified: boolean('is_verified').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_bank_accounts_user_id_idx').on(t.userId),
  ],
);

export type BillingBankAccount = typeof billingBankAccounts.$inferSelect;
export type NewBillingBankAccount = typeof billingBankAccounts.$inferInsert;
