import { pgTable, uuid, varchar, text, boolean, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';

export const mfaTypeEnum = pgEnum('mfa_type', ['TOTP', 'PASSKEY', 'SMS', 'EMAIL_OTP', 'BACKUP_CODE']);

export const mfaDevices = pgTable('mfa_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  type: mfaTypeEnum('type').notNull(),
  nickname: varchar('nickname', { length: 100 }), // e.g. "My iPhone", "Authenticator App"

  // Encrypted storage for TOTP secrets / FIDO2 public keys
  // AES-256 encrypted at the application layer before storing here
  secretOrPublicKey: text('secret_or_public_key').notNull(),

  // FIDO2/WebAuthn specific fields
  credentialId: text('credential_id').unique(), // WebAuthn credential ID
  counter: varchar('counter', { length: 20 }).default('0'), // FIDO2 signature counter

  isVerified: boolean('is_verified').notNull().default(false),
  isPrimary: boolean('is_primary').notNull().default(false),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type MfaDevice = typeof mfaDevices.$inferSelect;
export type NewMfaDevice = typeof mfaDevices.$inferInsert;
