"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizationMembers = exports.memberStatusEnum = exports.orgRoleEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
const organizations_1 = require("./organizations");
exports.orgRoleEnum = (0, pg_core_1.pgEnum)('org_role', ['OWNER', 'ADMIN', 'MEMBER']);
exports.memberStatusEnum = (0, pg_core_1.pgEnum)('member_status', ['ACTIVE', 'INVITED', 'SUSPENDED', 'LEFT']);
exports.organizationMembers = (0, pg_core_1.pgTable)('organization_members', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    organizationId: (0, pg_core_1.uuid)('organization_id').notNull().references(() => organizations_1.organizations.id, { onDelete: 'cascade' }),
    userId: (0, pg_core_1.uuid)('user_id').notNull().references(() => users_1.users.id, { onDelete: 'cascade' }),
    role: (0, exports.orgRoleEnum)('role').notNull().default('MEMBER'),
    status: (0, exports.memberStatusEnum)('status').notNull().default('INVITED'),
    // Who invited this member (nullable for founding owner)
    invitedByUserId: (0, pg_core_1.uuid)('invited_by_user_id').references(() => users_1.users.id, { onDelete: 'set null' }),
    joinedAt: (0, pg_core_1.timestamp)('joined_at', { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=organization_members.js.map