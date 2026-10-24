import { pgTable, uuid, varchar, text, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * analytics_events
 *
 * Append-only first-party telemetry events for funnels, user retention, and platform usage.
 * No third-party trackers (Google Analytics, Mixpanel, etc.).
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventName: varchar('event_name', { length: 64 }).notNull(), // e.g. 'page_view', 'signup_funnel_step', 'share_clicked'
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }), // null for unauthenticated sessions
    sessionId: varchar('session_id', { length: 128 }),

    path: varchar('path', { length: 255 }),
    referrer: text('referrer'),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),

    payload: jsonb('payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('analytics_events_event_name_idx').on(t.eventName),
    index('analytics_events_user_id_idx').on(t.userId),
    index('analytics_events_created_at_idx').on(t.createdAt),
  ],
);

export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type NewAnalyticsEvent = typeof analyticsEvents.$inferInsert;
