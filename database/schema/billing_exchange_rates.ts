import { pgTable, uuid, numeric, jsonb, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';

/**
 * billing_exchange_rates
 *
 * Stores every fetched exchange rate snapshot.
 * Immutable — rows are only inserted, never updated.
 *
 * Every billing_transactions row references the exact rate row
 * used at the moment of a funding/withdrawal operation.
 *
 * Rate source priority:
 *   1. Frankfurter (main, no key — ECB data)
 *   2. ExchangeRate-API v6 (fallback, key = ExchangeRateAPI_API_KEY)
 *   3. stale_fallback — last saved row returned when both APIs fail
 */
export const exchangeRateSourceEnum = pgEnum('exchange_rate_source', [
  'frankfurter',
  'exchangerate_api',
  'stale_fallback',
]);

export const billingExchangeRates = pgTable(
  'billing_exchange_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // 1 USD = usdToNgn NGN  (stored as text/numeric to preserve precision)
    usdToNgn: numeric('usd_to_ngn', { precision: 18, scale: 6 }).notNull(),

    source: exchangeRateSourceEnum('source').notNull(),

    // Raw API responses stored for full audit trail
    rawMainResponse: jsonb('raw_main_response'),
    rawFallbackResponse: jsonb('raw_fallback_response'),

    // When this rate was actually fetched from the API (or stale DB time)
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_exchange_rates_fetched_at_idx').on(t.fetchedAt),
  ],
);

export type BillingExchangeRate = typeof billingExchangeRates.$inferSelect;
export type NewBillingExchangeRate = typeof billingExchangeRates.$inferInsert;
