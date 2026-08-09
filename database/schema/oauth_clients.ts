import { pgTable, uuid, varchar, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  clientId: varchar('client_id', { length: 100 }).notNull().unique(),
  clientSecretHash: text('client_secret_hash'), // null for public clients (PKCE only)

  // Pipe-separated list of allowed redirect URIs
  redirectUris: text('redirect_uris').notNull(), // JSON array stored as text

  // Pipe-separated allowed scopes (e.g. "openid profile email")
  allowedScopes: text('allowed_scopes').notNull().default('openid profile email'),

  // Who owns this OAuth client registration
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

  // First-party = Crimfig-owned apps (ads, chat, etc.)
  // Third-party = External devs using "Sign in with Crimfig"
  isFirstParty: boolean('is_first_party').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),

  logoUrl: text('logo_url'),
  websiteUrl: text('website_url'),
  privacyPolicyUrl: text('privacy_policy_url'),
  termsOfServiceUrl: text('terms_of_service_url'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OauthClient = typeof oauthClients.$inferSelect;
export type NewOauthClient = typeof oauthClients.$inferInsert;
