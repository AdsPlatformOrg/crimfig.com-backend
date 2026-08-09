import { pgTable, uuid, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './organizations';

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Actor (who did it) — nullable for system-initiated events
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),

  // Event classification
  action: varchar('action', { length: 100 }).notNull(),
  // Examples: 'USER_LOGIN', 'USER_LOGOUT', 'ORG_CREATED', 'APP_CONSENT_GRANTED',
  //           'MFA_ENABLED', 'TOKEN_REVOKED', 'OWNER_QUORUM_VOTE', 'LEGACY_WATCHDOG_TRIGGERED'

  // Resource that was acted on
  resourceType: varchar('resource_type', { length: 100 }), // 'user', 'organization', 'app', etc.
  resourceId: varchar('resource_id', { length: 255 }),

  // Structured metadata — app-specific payload for this event
  metadata: jsonb('metadata'),

  // Request context
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  requestId: varchar('request_id', { length: 100 }), // correlates with application logs

  // Outcome
  success: varchar('success', { length: 10 }).notNull().default('true'),
  errorCode: varchar('error_code', { length: 100 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
