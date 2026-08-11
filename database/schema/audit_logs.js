"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogs = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
const organizations_1 = require("./organizations");
exports.auditLogs = (0, pg_core_1.pgTable)('audit_logs', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    // Actor (who did it) — nullable for system-initiated events
    userId: (0, pg_core_1.uuid)('user_id').references(() => users_1.users.id, { onDelete: 'set null' }),
    organizationId: (0, pg_core_1.uuid)('organization_id').references(() => organizations_1.organizations.id, { onDelete: 'set null' }),
    // Event classification
    action: (0, pg_core_1.varchar)('action', { length: 100 }).notNull(),
    // Examples: 'USER_LOGIN', 'USER_LOGOUT', 'ORG_CREATED', 'APP_CONSENT_GRANTED',
    //           'MFA_ENABLED', 'TOKEN_REVOKED', 'OWNER_QUORUM_VOTE', 'LEGACY_WATCHDOG_TRIGGERED'
    // Resource that was acted on
    resourceType: (0, pg_core_1.varchar)('resource_type', { length: 100 }), // 'user', 'organization', 'app', etc.
    resourceId: (0, pg_core_1.varchar)('resource_id', { length: 255 }),
    // Structured metadata — app-specific payload for this event
    metadata: (0, pg_core_1.jsonb)('metadata'),
    // Request context
    ipAddress: (0, pg_core_1.varchar)('ip_address', { length: 45 }),
    userAgent: (0, pg_core_1.text)('user_agent'),
    requestId: (0, pg_core_1.varchar)('request_id', { length: 100 }), // correlates with application logs
    // Outcome
    success: (0, pg_core_1.varchar)('success', { length: 10 }).notNull().default('true'),
    errorCode: (0, pg_core_1.varchar)('error_code', { length: 100 }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=audit_logs.js.map