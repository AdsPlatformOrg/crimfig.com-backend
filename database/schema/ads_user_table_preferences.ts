import { pgTable, uuid, varchar, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * ads_user_table_preferences
 *
 * Persists customized columns, column visibility, and ordering for ads reporting tables
 * on a per-user basis.
 */
export const adsUserTablePreferences = pgTable(
  'ads_user_table_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tableName: varchar('table_name', { length: 64 }).notNull().default('campaigns_performance'),

    // JSON string containing array of column configurations: { key: string, visible: boolean, order: number }
    columnsConfig: text('columns_config').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ads_user_table_prefs_user_id_idx').on(t.userId),
    unique('ads_user_table_prefs_user_table_uniq').on(t.userId, t.tableName),
  ],
);

export type AdsUserTablePreference = typeof adsUserTablePreferences.$inferSelect;
export type NewAdsUserTablePreference = typeof adsUserTablePreferences.$inferInsert;
