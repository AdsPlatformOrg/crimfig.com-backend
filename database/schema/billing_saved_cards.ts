import { pgTable, uuid, varchar, text, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * billing_saved_cards
 *
 * PCI DSS: We NEVER store raw card numbers, CVVs, or PANs.
 * Only the PSP-issued token is stored:
 *   - Paystack: authorization_code (reusable only if authorization.reusable === true)
 *   - Stripe:   payment_method_id (pm_...)
 *
 * The authorization_code / payment_method_id are NOT logged in bulk queries.
 * They are only fetched when needed for a charge operation.
 *
 * signature: Paystack's card fingerprint — used for deduplication.
 * last4 + exp_month + exp_year displayed in UI only.
 */
export const cardProviderEnum = pgEnum('card_provider', ['paystack', 'stripe']);

export const billingSavedCards = pgTable(
  'billing_saved_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    provider: cardProviderEnum('provider').notNull(),

    // Paystack: authorization_code | Stripe: payment_method_id
    // NOT returned in list queries — only fetched for charge operations
    providerToken: text('provider_token').notNull(),

    // Deduplication fingerprint (Paystack: authorization.signature)
    signature: varchar('signature', { length: 255 }),

    // Display metadata (safe to show in UI)
    cardBrand: varchar('card_brand', { length: 30 }),    // visa, mastercard, verve
    last4: varchar('last4', { length: 4 }).notNull(),
    expMonth: varchar('exp_month', { length: 2 }).notNull(),
    expYear: varchar('exp_year', { length: 4 }).notNull(),
    bank: varchar('bank', { length: 100 }),
    cardType: varchar('card_type', { length: 30 }),      // debit, credit

    // Billing email used when this card was first charged
    billingEmail: varchar('billing_email', { length: 255 }),

    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_saved_cards_user_id_idx').on(t.userId),
    index('billing_saved_cards_signature_idx').on(t.userId, t.signature),
  ],
);

export type BillingSavedCard = typeof billingSavedCards.$inferSelect;
export type NewBillingSavedCard = typeof billingSavedCards.$inferInsert;
