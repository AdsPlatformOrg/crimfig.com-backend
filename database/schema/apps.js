"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apps = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
exports.apps = (0, pg_core_1.pgTable)('apps', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    // OAuth client_id used in authorization requests (e.g. "crimfig_ads", "crimfig_chat")
    clientId: (0, pg_core_1.varchar)('client_id', { length: 100 }).notNull().unique(),
    // Hashed client secret for confidential clients (server-side apps)
    clientSecretHash: (0, pg_core_1.text)('client_secret_hash'),
    name: (0, pg_core_1.varchar)('name', { length: 100 }).notNull(), // Display name: "CrimFig Ads"
    subdomain: (0, pg_core_1.varchar)('subdomain', { length: 100 }).notNull().unique(), // "ads.crimfig.com"
    description: (0, pg_core_1.text)('description'),
    logoUrl: (0, pg_core_1.text)('logo_url'),
    // The current version of the ToS; bumping this forces all users to re-consent
    currentTermsVersion: (0, pg_core_1.varchar)('current_terms_version', { length: 20 }).notNull().default('1.0.0'),
    termsUrl: (0, pg_core_1.text)('terms_url'),
    privacyUrl: (0, pg_core_1.text)('privacy_url'),
    // First-party apps (Crimfig-owned) skip certain consent screens
    isFirstParty: (0, pg_core_1.boolean)('is_first_party').notNull().default(true),
    isActive: (0, pg_core_1.boolean)('is_active').notNull().default(true),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=apps.js.map