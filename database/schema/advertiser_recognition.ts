import { pgTable, uuid, text, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/** Recognition only. No amount, credit balance or money authority lives here. */
export const advertiserRecognitionAwards = pgTable('advertiser_recognition_awards', {
  id: uuid('id').primaryKey().defaultRandom(),
  advertiserId: uuid('advertiser_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  milestoneId: text('milestone_id').notNull(),
  qualifyingScope: text('qualifying_scope').notNull().default('lifetime'),
  policyVersion: text('policy_version').notNull(),
  state: text('state').notNull(),
  firstQualifiedAt: timestamp('first_qualified_at', { withTimezone: true }).notNull().defaultNow(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  evidence: jsonb('evidence').notNull(),
}, table => [unique().on(table.advertiserId, table.milestoneId, table.qualifyingScope)]);

/** Migration 0052 enforces append-only history, including against TRUNCATE. */
export const advertiserRecognitionEvaluations = pgTable('advertiser_recognition_evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  awardId: uuid('award_id').notNull().references(() => advertiserRecognitionAwards.id, { onDelete: 'restrict' }),
  previousState: text('previous_state'),
  state: text('state').notNull(),
  policyVersion: text('policy_version').notNull(),
  evidence: jsonb('evidence').notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
});
