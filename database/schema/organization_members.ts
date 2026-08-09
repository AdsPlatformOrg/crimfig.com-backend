import { pgTable, uuid, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';
import { organizations } from './organizations';

export const orgRoleEnum = pgEnum('org_role', ['OWNER', 'ADMIN', 'MEMBER']);
export const memberStatusEnum = pgEnum('member_status', ['ACTIVE', 'INVITED', 'SUSPENDED', 'LEFT']);

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgRoleEnum('role').notNull().default('MEMBER'),
  status: memberStatusEnum('status').notNull().default('INVITED'),

  // Who invited this member (nullable for founding owner)
  invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),

  joinedAt: timestamp('joined_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OrgMember = typeof organizationMembers.$inferSelect;
export type NewOrgMember = typeof organizationMembers.$inferInsert;
