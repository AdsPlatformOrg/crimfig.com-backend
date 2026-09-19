import { pgTable, uuid, varchar, text, boolean, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { billingSavedCards } from './billing_saved_cards';

/**
 * billing_subscriptions
 *
 * One row per user per CrimFig app subscription.
 * app_slug identifies which CrimFig service this subscription is for
 * (e.g. 'reels', 'chat', 'tetris', 'stream').
 *
 * Auto-renewal: A NestJS cron job runs daily, finds rows where
 * next_billing_date <= now AND cancel_at_period_end = false,
 * then charges the saved_card_id via Paystack charge_authorization.
 *
 * Payment flow:
 *   New card → Paystack Initialize → webhook fulfills → row created/updated
 *   Saved card → charge_authorization immediately → webhook fulfills
 */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'cancelled',
  'expired',
  'trialing',
]);

export const subscriptionPlanEnum = pgEnum('subscription_plan', [
  'monthly',
  'annual',
]);

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

    // Which CrimFig service this subscription is for
    appSlug: varchar('app_slug', { length: 50 }).notNull(), // 'reels' | 'chat' | 'tetris' | ...

    plan: subscriptionPlanEnum('plan').notNull().default('monthly'),
    status: subscriptionStatusEnum('status').notNull().default('active'),

    // Amount billed per cycle (in USD cents)
    priceUsdCents: integer('price_usd_cents').notNull(),

    // Provider used for this subscription
    provider: varchar('provider', { length: 20 }).notNull().default('paystack'), // paystack | stripe

    // The saved card used for auto-renewal (nullable: may use new card each time)
    savedCardId: uuid('saved_card_id').references(() => billingSavedCards.id, { onDelete: 'set null' }),

    // Billing period tracking
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    nextBillingDate: timestamp('next_billing_date', { withTimezone: true }).notNull(),

    // When set to true, subscription ends at current_period_end without auto-renewing
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    // Last payment reference for this subscription cycle
    lastPaymentReference: text('last_payment_reference'),
    lastPaymentDate: timestamp('last_payment_date', { withTimezone: true }),

    // Count consecutive failed renewal attempts (for past_due escalation)
    failedRenewalAttempts: integer('failed_renewal_attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_subscriptions_user_id_idx').on(t.userId),
    index('billing_subscriptions_app_slug_idx').on(t.appSlug),
    index('billing_subscriptions_next_billing_idx').on(t.nextBillingDate),
    index('billing_subscriptions_status_idx').on(t.status),
  ],
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
