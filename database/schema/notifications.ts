import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, index, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * notification_channel_enum
 */
export const notificationChannelEnum = pgEnum('notification_channel', [
  'in_app',
  'email',
  'push',
]);

/**
 * notification_severity_enum
 */
export const notificationSeverityEnum = pgEnum('notification_severity', [
  'info',
  'success',
  'warning',
  'critical',
]);

/**
 * user_notifications
 *
 * Durable in-app inbox items for users and staff members.
 */
export const userNotifications = pgTable(
  'user_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    app: varchar('app', { length: 32 }).notNull().default('all'), // 'ads' | 'billing' | 'auth' | 'all'

    eventType: varchar('event_type', { length: 64 }).notNull(), // 'moderation.decision', 'billing.payment', 'ticket.reply', 'rewards.credited'
    severity: notificationSeverityEnum('severity').notNull().default('info'),

    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    actionUrl: varchar('action_url', { length: 255 }), // Deep link to dashboard section

    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),

    isArchived: boolean('is_archived').notNull().default(false),
    payload: jsonb('payload'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_notifications_user_id_idx').on(t.userId),
    index('user_notifications_is_read_idx').on(t.isRead),
    index('user_notifications_created_at_idx').on(t.createdAt),
  ],
);

/**
 * notification_preferences
 *
 * Granular notification channels, digests, and quiet hours preferences per user.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

    emailEnabled: boolean('email_enabled').notNull().default(true),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),

    campaignAlerts: boolean('campaign_alerts').notNull().default(true),
    billingAlerts: boolean('billing_alerts').notNull().default(true),
    moderationAlerts: boolean('moderation_alerts').notNull().default(true),
    supportAlerts: boolean('support_alerts').notNull().default(true),

    quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(false),
    quietHoursStartUtc: varchar('quiet_hours_start_utc', { length: 5 }).default('22:00'),
    quietHoursEndUtc: varchar('quiet_hours_end_utc', { length: 5 }).default('07:00'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notification_preferences_user_id_idx').on(t.userId),
  ],
);

export type UserNotification = typeof userNotifications.$inferSelect;
export type NewUserNotification = typeof userNotifications.$inferInsert;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference = typeof notificationPreferences.$inferInsert;
