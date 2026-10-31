import { pgTable, uuid, integer, varchar, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { adsCampaigns } from './ads_campaigns';

// Restricted records: no owner/reviewer API returns historical snapshots or mutation payloads.
export const adsCampaignSubmissions = pgTable('ads_campaign_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull(), requestId: uuid('request_id').notNull(),
  contentRevision: integer('content_revision').notNull(), fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  snapshot: jsonb('snapshot').notNull(),
  snapshotHash:varchar('snapshot_hash',{length:64}),purgedAt:timestamp('purged_at',{withTimezone:true}),
  state: varchar('state', { length: 30 }).notNull(),
  fundingReference: jsonb('funding_reference'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('ads_submission_request_uq').on(t.campaignId, t.actorId, t.requestId), index('ads_submission_state_idx').on(t.state)]);

export const adsCampaignMutations = pgTable('ads_campaign_mutations', {
  id: uuid('id').primaryKey().defaultRandom(), campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull(), requestId: uuid('request_id').notNull(), action: varchar('action', { length: 80 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(), result: jsonb('result').notNull(),
  purgedAt:timestamp('purged_at',{withTimezone:true}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('ads_mutation_request_uq').on(t.campaignId, t.actorId, t.requestId)]);

export const adsCampaignChanges = pgTable('ads_campaign_changes', {
  id: uuid('id').primaryKey().defaultRandom(), campaignId: uuid('campaign_id').notNull().references(() => adsCampaigns.id, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull(), requestId: uuid('request_id').notNull(), action: varchar('action', { length: 80 }).notNull(),
  priorRevision: integer('prior_revision').notNull(), contentRevision: integer('content_revision').notNull(),
  previousSubmissionId: uuid('previous_submission_id'), submissionId: uuid('submission_id'),
  beforeHash: varchar('before_hash', { length: 64 }).notNull(), afterHash: varchar('after_hash', { length: 64 }).notNull(),
  changedFields: jsonb('changed_fields').notNull(), entityIds: jsonb('entity_ids').notNull(),
  beforeSnapshot: jsonb('before_snapshot').notNull(), afterSnapshot: jsonb('after_snapshot').notNull(),
  purgedAt:timestamp('purged_at',{withTimezone:true}),
  policyVersion: varchar('policy_version', { length: 40 }).notNull().default('campaign-audit-v1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('ads_campaign_changes_idx').on(t.campaignId, t.createdAt)]);
