"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.users = exports.userStatusEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
exports.userStatusEnum = (0, pg_core_1.pgEnum)('user_status', ['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DELETED']);
exports.users = (0, pg_core_1.pgTable)('users', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    email: (0, pg_core_1.varchar)('email', { length: 255 }).notNull().unique(),
    phone: (0, pg_core_1.varchar)('phone', { length: 30 }).unique(),
    passwordHash: (0, pg_core_1.text)('password_hash'), // nullable for OAuth-only accounts
    status: (0, exports.userStatusEnum)('status').notNull().default('PENDING_VERIFICATION'),
    isEmailVerified: (0, pg_core_1.boolean)('is_email_verified').notNull().default(false),
    isPhoneVerified: (0, pg_core_1.boolean)('is_phone_verified').notNull().default(false),
    mfaEnabled: (0, pg_core_1.boolean)('mfa_enabled').notNull().default(false),
    preferredLocale: (0, pg_core_1.varchar)('preferred_locale', { length: 10 }).notNull().default('en'),
    lastLoginAt: (0, pg_core_1.timestamp)('last_login_at', { withTimezone: true }),
    lastActivityAt: (0, pg_core_1.timestamp)('last_activity_at', { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=users.js.map