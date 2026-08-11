"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userAppConsents = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
const organizations_1 = require("./organizations");
const apps_1 = require("./apps");
exports.userAppConsents = (0, pg_core_1.pgTable)('user_app_consents', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').notNull().references(() => users_1.users.id, { onDelete: 'cascade' }),
    // Nullable: consent can be personal or on behalf of an org
    organizationId: (0, pg_core_1.uuid)('organization_id').references(() => organizations_1.organizations.id, { onDelete: 'cascade' }),
    appId: (0, pg_core_1.uuid)('app_id').notNull().references(() => apps_1.apps.id, { onDelete: 'cascade' }),
    // Version of ToS accepted — must match apps.currentTermsVersion for access to be granted
    termsVersionAccepted: (0, pg_core_1.varchar)('terms_version_accepted', { length: 20 }).notNull(),
    agreedAt: (0, pg_core_1.timestamp)('agreed_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: (0, pg_core_1.varchar)('ip_address', { length: 45 }), // supports IPv6
    userAgent: (0, pg_core_1.text)('user_agent'),
    // If terms are revoked/withdrawn
    revokedAt: (0, pg_core_1.timestamp)('revoked_at', { withTimezone: true }),
});
//# sourceMappingURL=user_app_consents.js.map