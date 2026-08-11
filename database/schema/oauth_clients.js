"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.oauthClients = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
exports.oauthClients = (0, pg_core_1.pgTable)('oauth_clients', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    name: (0, pg_core_1.varchar)('name', { length: 255 }).notNull(),
    clientId: (0, pg_core_1.varchar)('client_id', { length: 100 }).notNull().unique(),
    clientSecretHash: (0, pg_core_1.text)('client_secret_hash'), // null for public clients (PKCE only)
    // Pipe-separated list of allowed redirect URIs
    redirectUris: (0, pg_core_1.text)('redirect_uris').notNull(), // JSON array stored as text
    // Pipe-separated allowed scopes (e.g. "openid profile email")
    allowedScopes: (0, pg_core_1.text)('allowed_scopes').notNull().default('openid profile email'),
    // Who owns this OAuth client registration
    ownerUserId: (0, pg_core_1.uuid)('owner_user_id').references(() => users_1.users.id, { onDelete: 'set null' }),
    // First-party = Crimfig-owned apps (ads, chat, etc.)
    // Third-party = External devs using "Sign in with Crimfig"
    isFirstParty: (0, pg_core_1.boolean)('is_first_party').notNull().default(false),
    isActive: (0, pg_core_1.boolean)('is_active').notNull().default(true),
    logoUrl: (0, pg_core_1.text)('logo_url'),
    websiteUrl: (0, pg_core_1.text)('website_url'),
    privacyPolicyUrl: (0, pg_core_1.text)('privacy_policy_url'),
    termsOfServiceUrl: (0, pg_core_1.text)('terms_of_service_url'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=oauth_clients.js.map