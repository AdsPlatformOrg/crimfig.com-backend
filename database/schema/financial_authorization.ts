import { pgTable, uuid, text, jsonb, timestamp, integer, boolean, bigint, primaryKey } from 'drizzle-orm/pg-core';
import { users } from './users';
import { mfaDevices } from './mfa_devices';

/** Independently provisioned identity mapping, not a public profile-edit field. */
export const financialIdentities = pgTable('auth_financial_identities', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  personId: text('person_id').notNull(), active: boolean('active').notNull().default(false),
  recoveryClearedAt: timestamp('recovery_cleared_at', { withTimezone: true }).notNull(),
});
export const financialChallenges = pgTable('auth_financial_challenges', {
  id: uuid('id').primaryKey(), actorId: uuid('actor_id').notNull().references(() => users.id),
  proposal: jsonb('proposal').notNull(), attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  proof: jsonb('proof'), consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const financialTotpUses = pgTable('auth_financial_totp_uses', {
  deviceId: uuid('device_id').notNull().references(() => mfaDevices.id),
  step: bigint('step', { mode: 'number' }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.deviceId, t.step] })]);
