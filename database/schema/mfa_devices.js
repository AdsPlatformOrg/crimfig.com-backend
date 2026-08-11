"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mfaDevices = exports.mfaTypeEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
exports.mfaTypeEnum = (0, pg_core_1.pgEnum)('mfa_type', ['TOTP', 'PASSKEY', 'SMS', 'EMAIL_OTP', 'BACKUP_CODE']);
exports.mfaDevices = (0, pg_core_1.pgTable)('mfa_devices', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').notNull().references(() => users_1.users.id, { onDelete: 'cascade' }),
    type: (0, exports.mfaTypeEnum)('type').notNull(),
    nickname: (0, pg_core_1.varchar)('nickname', { length: 100 }), // e.g. "My iPhone", "Authenticator App"
    // Encrypted storage for TOTP secrets / FIDO2 public keys
    // AES-256 encrypted at the application layer before storing here
    secretOrPublicKey: (0, pg_core_1.text)('secret_or_public_key').notNull(),
    // FIDO2/WebAuthn specific fields
    credentialId: (0, pg_core_1.text)('credential_id').unique(), // WebAuthn credential ID
    counter: (0, pg_core_1.varchar)('counter', { length: 20 }).default('0'), // FIDO2 signature counter
    isVerified: (0, pg_core_1.boolean)('is_verified').notNull().default(false),
    isPrimary: (0, pg_core_1.boolean)('is_primary').notNull().default(false),
    lastUsedAt: (0, pg_core_1.timestamp)('last_used_at', { withTimezone: true }),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: (0, pg_core_1.timestamp)('revoked_at', { withTimezone: true }),
});
//# sourceMappingURL=mfa_devices.js.map