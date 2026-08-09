import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './organizations';
import { apps } from './apps';

export const userAppConsents = pgTable('user_app_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Nullable: consent can be personal or on behalf of an org
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),

  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),

  // Version of ToS accepted — must match apps.currentTermsVersion for access to be granted
  termsVersionAccepted: varchar('terms_version_accepted', { length: 20 }).notNull(),

  agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }), // supports IPv6
  userAgent: text('user_agent'),

  // If terms are revoked/withdrawn
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type UserAppConsent = typeof userAppConsents.$inferSelect;
export type NewUserAppConsent = typeof userAppConsents.$inferInsert;
