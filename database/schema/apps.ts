import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';

export const apps = pgTable('apps', {
  id: uuid('id').primaryKey().defaultRandom(),

  // OAuth client_id used in authorization requests (e.g. "crimfig_ads", "crimfig_chat")
  clientId: varchar('client_id', { length: 100 }).notNull().unique(),

  // Hashed client secret for confidential clients (server-side apps)
  clientSecretHash: text('client_secret_hash'),

  name: varchar('name', { length: 100 }).notNull(), // Display name: "CrimFig Ads"
  subdomain: varchar('subdomain', { length: 100 }).notNull().unique(), // "ads.crimfig.com"
  description: text('description'),
  logoUrl: text('logo_url'),

  // The current version of the ToS; bumping this forces all users to re-consent
  currentTermsVersion: varchar('current_terms_version', { length: 20 }).notNull().default('1.0.0'),
  termsUrl: text('terms_url'),
  privacyUrl: text('privacy_url'),

  // First-party apps (Crimfig-owned) skip certain consent screens
  isFirstParty: boolean('is_first_party').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
