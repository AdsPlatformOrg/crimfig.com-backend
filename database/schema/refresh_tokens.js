"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshTokens = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
const apps_1 = require("./apps");
exports.refreshTokens = (0, pg_core_1.pgTable)('refresh_tokens', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').notNull().references(() => users_1.users.id, { onDelete: 'cascade' }),
    appId: (0, pg_core_1.uuid)('app_id').notNull().references(() => apps_1.apps.id, { onDelete: 'cascade' }),
    // SHA-256 hash of the actual token — never store raw tokens
    tokenHash: (0, pg_core_1.text)('token_hash').notNull().unique(),
    // Token family: all tokens issued from the same initial auth share a family ID.
    // If a rotated token is reused (stolen), the entire family is revoked.
    familyId: (0, pg_core_1.uuid)('family_id').notNull(),
    // Device fingerprint for anomaly detection (not PII — hashed browser/device signature)
    deviceFingerprint: (0, pg_core_1.varchar)('device_fingerprint', { length: 255 }),
    expiresAt: (0, pg_core_1.timestamp)('expires_at', { withTimezone: true }).notNull(),
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Populated when revoked — either by user sign-out or security incident
    revokedAt: (0, pg_core_1.timestamp)('revoked_at', { withTimezone: true }),
});
//# sourceMappingURL=refresh_tokens.js.map