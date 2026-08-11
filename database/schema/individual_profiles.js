"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.individualProfiles = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const users_1 = require("./users");
exports.individualProfiles = (0, pg_core_1.pgTable)('individual_profiles', {
    id: (0, pg_core_1.uuid)('id').primaryKey().defaultRandom(),
    userId: (0, pg_core_1.uuid)('user_id').notNull().unique().references(() => users_1.users.id, { onDelete: 'cascade' }),
    fullName: (0, pg_core_1.varchar)('full_name', { length: 255 }),
    displayName: (0, pg_core_1.varchar)('display_name', { length: 100 }),
    avatarUrl: (0, pg_core_1.text)('avatar_url'),
    bio: (0, pg_core_1.text)('bio'),
    timezone: (0, pg_core_1.varchar)('timezone', { length: 64 }).default('Africa/Lagos'),
    country: (0, pg_core_1.varchar)('country', { length: 2 }).default('NG'), // ISO 3166-1 alpha-2
    createdAt: (0, pg_core_1.timestamp)('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
//# sourceMappingURL=individual_profiles.js.map