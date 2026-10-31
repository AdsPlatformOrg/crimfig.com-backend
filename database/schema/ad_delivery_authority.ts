import {pgTable,uuid,varchar,text,integer,bigserial,jsonb,timestamp,boolean,index,uniqueIndex} from 'drizzle-orm/pg-core';
import {adsCampaigns} from './ads_campaigns';

export const adsEventAssessments=pgTable('ads_event_assessments',{
  id:uuid('id').primaryKey().defaultRandom(),eventId:uuid('event_id').notNull(),campaignId:uuid('campaign_id'),
  requestId:uuid('request_id').notNull().unique(),actorId:uuid('actor_id').notNull(),policyVersion:varchar('policy_version',{length:64}).notNull(),
  outcome:varchar('outcome',{length:24}).notNull(),reasonCodes:jsonb('reason_codes').notNull(),features:jsonb('features').notNull(),
  supersedesId:uuid('supersedes_id'),recordHash:varchar('record_hash',{length:64}).notNull(),keyId:varchar('key_id',{length:40}).notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[index('ads_assessment_event_idx').on(t.eventId,t.createdAt)]);

export const adsEvidenceRecords=pgTable('ads_evidence_records',{
  id:uuid('id').primaryKey().defaultRandom(),eventId:uuid('event_id').notNull().unique(),sequence:bigserial('sequence',{mode:'number'}).notNull(),
  partition:varchar('partition',{length:80}).notNull(),payload:jsonb('payload').notNull(),previousHash:varchar('previous_hash',{length:64}),
  recordHash:varchar('record_hash',{length:64}).notNull(),keyId:varchar('key_id',{length:40}).notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[index('ads_evidence_partition_idx').on(t.partition,t.sequence)]);

export const adsRetentionHolds=pgTable('ads_retention_holds',{
  campaignId:uuid('campaign_id').primaryKey().references(()=>adsCampaigns.id,{onDelete:'restrict'}),active:boolean('active').notNull().default(true),
  actorId:uuid('actor_id').notNull(),requestId:uuid('request_id').notNull(),reason:text('reason').notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});

export const errorMonitorSourceOutbox=pgTable('error_monitor_source_outbox',{
  id:uuid('id').primaryKey().defaultRandom(),service:varchar('service',{length:64}).notNull(),environment:varchar('environment',{length:32}).notNull(),
  payload:jsonb('payload').notNull(),status:varchar('status',{length:24}).notNull().default('pending'),attempts:integer('attempts').notNull().default(0),
  nextAttemptAt:timestamp('next_attempt_at',{withTimezone:true}).notNull().defaultNow(),leaseId:uuid('lease_id'),leaseExpiresAt:timestamp('lease_expires_at',{withTimezone:true}),
  lastErrorCode:varchar('last_error_code',{length:64}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),deliveredAt:timestamp('delivered_at',{withTimezone:true}),
},t=>[index('error_source_outbox_due_idx').on(t.service,t.status,t.nextAttemptAt)]);

export const errorMonitorIngestReceipts=pgTable('error_monitor_ingest_receipts',{
  id:uuid('id').primaryKey().defaultRandom(),sourceEventId:uuid('source_event_id').notNull(),service:varchar('service',{length:64}).notNull(),
  environment:varchar('environment',{length:32}).notNull(),fingerprint:varchar('fingerprint',{length:64}).notNull(),result:jsonb('result').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('error_ingest_receipt_uq').on(t.environment,t.service,t.sourceEventId)]);

export const errorMonitorSourceActions=pgTable('error_monitor_source_actions',{
  id:uuid('id').primaryKey().defaultRandom(),sourceId:uuid('source_id').notNull().references(()=>errorMonitorSourceOutbox.id),actorId:uuid('actor_id').notNull(),
  requestId:uuid('request_id').notNull().unique(),reason:text('reason').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
