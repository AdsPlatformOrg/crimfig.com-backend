"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizations = exports.orgStatusEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
exports.orgStatusEnum = (0, pg_core_1.pgEnum)('org_status', ['ACTIVE', 'SUSPENDED', 'PENDING', 'DELETED']);
exports.organizations = (0, pg_core_1.pgTable)('organizations', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    name: (0, pg_core_1.varchar)('name', { length: 255 }).notNull(),
    slug: (0, pg_core_1.varchar)('slug', { length: 100 }).notNull().unique(), // e.g. "acme-corp"
    description: (0, pg_core_1.text)('description'),
    logoUrl: (0, pg_core_1.text)('logo_url'),
    website: (0, pg_core_1.varchar)('website', { length: 255 }),
    country: (0, pg_core_1.varchar)('country', { length: 2 }).default('NG'), // ISO 3166-1 alpha-2
    status: (0, exports.orgStatusEnum)('status').notNull().default('PENDING'),
    // Multi-Owner quorum: N owners must approve critical actions
    // e.g. ownerQuorumCount = 2 means any 2 owners must approve
    ownerQuorumCount: (0, pg_core_1.integer)('owner_quorum_count').notNull().default(2),
    // Legacy Watchdog: inactivity period in days before succession is triggered
    // null means disabled
    inactivityDaysTrigger: (0, pg_core_1.integer)('inactivity_days_trigger'),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: (0, pg_core_1.timestamp)('deleted_at', { withTimezone: true }), // soft delete
});
//# sourceMappingURL=organizations.js.map