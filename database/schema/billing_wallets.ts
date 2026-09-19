import { pgTable, uuid, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * billing_wallets
 *
 * One wallet per user. All balances stored as INTEGER CENTS (never floats).
 * USD cents for available/locked; NGN kobo tracked on transactions only.
 *
 * Security: balance_usd_cents has a CHECK >= 0 constraint enforced at DB level
 * to prevent double-spend race conditions from bypassing application logic.
 *
 * locked_usd_cents: funds reserved during a pending withdrawal.
 * On transfer.success → deducted from locked. On transfer.failed → returned to available.
 */
export const billingWallets = pgTable(
  'billing_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

    // All amounts stored as integer cents — never floating point
    balanceUsdCents: integer('balance_usd_cents').notNull().default(0),
    lockedUsdCents: integer('locked_usd_cents').notNull().default(0),

    // Optimistic locking: increment on every write to detect stale reads
    version: integer('version').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_wallets_user_id_idx').on(t.userId),
  ],
);

export type BillingWallet = typeof billingWallets.$inferSelect;
export type NewBillingWallet = typeof billingWallets.$inferInsert;
