import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const orgStatusEnum = pgEnum('org_status', ['ACTIVE', 'SUSPENDED', 'PENDING', 'DELETED']);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(), // e.g. "acme-corp"
  description: text('description'),
  logoUrl: text('logo_url'),
  website: varchar('website', { length: 255 }),
  country: varchar('country', { length: 2 }).default('NG'), // ISO 3166-1 alpha-2
  status: orgStatusEnum('status').notNull().default('PENDING'),

  // Multi-Owner quorum: N owners must approve critical actions
  // e.g. ownerQuorumCount = 2 means any 2 owners must approve
  ownerQuorumCount: integer('owner_quorum_count').notNull().default(2),

  // Legacy Watchdog: inactivity period in days before succession is triggered
  // null means disabled
  inactivityDaysTrigger: integer('inactivity_days_trigger'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }), // soft delete
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
