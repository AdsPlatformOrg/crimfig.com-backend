import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';
import { apps } from './apps';

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),

  // SHA-256 hash of the actual token — never store raw tokens
  tokenHash: text('token_hash').notNull().unique(),

  // Token family: all tokens issued from the same initial auth share a family ID.
  // If a rotated token is reused (stolen), the entire family is revoked.
  familyId: uuid('family_id').notNull(),

  // Device fingerprint for anomaly detection (not PII — hashed browser/device signature)
  deviceFingerprint: varchar('device_fingerprint', { length: 255 }),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Populated when revoked — either by user sign-out or security incident
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
