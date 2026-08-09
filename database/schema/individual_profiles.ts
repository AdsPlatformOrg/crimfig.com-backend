import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const individualProfiles = pgTable('individual_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  fullName: varchar('full_name', { length: 255 }),
  displayName: varchar('display_name', { length: 100 }),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  timezone: varchar('timezone', { length: 64 }).default('Africa/Lagos'),
  country: varchar('country', { length: 2 }).default('NG'), // ISO 3166-1 alpha-2
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type IndividualProfile = typeof individualProfiles.$inferSelect;
export type NewIndividualProfile = typeof individualProfiles.$inferInsert;
