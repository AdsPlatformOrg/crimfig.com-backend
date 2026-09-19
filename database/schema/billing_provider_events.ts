import { pgTable, uuid, text, boolean, jsonb, timestamp, pgEnum, index, unique } from 'drizzle-orm/pg-core';

/**
 * billing_provider_events
 *
 * Idempotency table for all incoming webhook events from PSPs.
 *
 * BEFORE processing any webhook:
 *   1. Insert a row with processed = false (or check if reference already exists)
 *   2. If a UNIQUE constraint violation occurs → event already received → return 200 OK immediately
 *   3. Process the event inside a DB transaction
 *   4. On commit → UPDATE processed = true, processed_at = now()
 *   5. On error → UPDATE error_message, leave processed = false (Paystack will retry)
 *
 * raw_payload: The complete, unmodified webhook JSON as received from the PSP.
 * Never mutated after insert.
 */
export const providerEventProviderEnum = pgEnum('provider_event_provider', [
  'paystack',
  'stripe',
]);

export const billingProviderEvents = pgTable(
  'billing_provider_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    provider: providerEventProviderEnum('provider').notNull(),

    // Paystack: data.reference | Stripe: event.id
    // UNIQUE constraint enforces idempotency at DB level
    reference: text('reference').notNull(),

    // Paystack: e.g. 'charge.success' | Stripe: 'payment_intent.succeeded'
    eventType: text('event_type').notNull(),

    // Full raw payload — never modified after insert
    rawPayload: jsonb('raw_payload').notNull(),

    processed: boolean('processed').notNull().default(false),
    processedAt: timestamp('processed_at', { withTimezone: true }),

    // Set if processing threw an error (for debugging + retry logic)
    errorMessage: text('error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('billing_provider_events_ref_unique').on(t.provider, t.reference),
    index('billing_provider_events_processed_idx').on(t.processed),
    index('billing_provider_events_event_type_idx').on(t.eventType),
  ],
);

export type BillingProviderEvent = typeof billingProviderEvents.$inferSelect;
export type NewBillingProviderEvent = typeof billingProviderEvents.$inferInsert;
