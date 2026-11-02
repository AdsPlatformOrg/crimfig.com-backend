import {pgTable,uuid,varchar,integer,timestamp,text,jsonb,uniqueIndex,index} from 'drizzle-orm/pg-core';
import {adsCampaigns} from './ads_campaigns';
import {adsCampaignSubmissions} from './ads_campaign_workflow';
import {users} from './users';
export const adsModerationClaims=pgTable('ads_moderation_claims',{
 id:uuid('id').primaryKey().defaultRandom(),campaignId:uuid('campaign_id').notNull().references(()=>adsCampaigns.id),
 targetType:varchar('target_type',{length:16}).notNull(),targetId:uuid('target_id').notNull(),
 submissionId:uuid('submission_id').notNull().references(()=>adsCampaignSubmissions.id),contentRevision:integer('content_revision').notNull(),
 stage:varchar('stage',{length:16}).notNull(),claimantId:uuid('claimant_id').notNull().references(()=>users.id),
 claimedAt:timestamp('claimed_at',{withTimezone:true}).notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),releasedAt:timestamp('released_at',{withTimezone:true}),
},t=>[uniqueIndex('ads_moderation_claim_identity_uq').on(t.targetType,t.targetId,t.submissionId,t.contentRevision,t.stage),index('ads_moderation_claims_campaign_idx').on(t.campaignId)]);
export const adsModerationClaimEvents=pgTable('ads_moderation_claim_events',{
 id:uuid('id').primaryKey().defaultRandom(),campaignId:uuid('campaign_id').notNull().references(()=>adsCampaigns.id),claimId:uuid('claim_id').notNull(),
 actorId:uuid('actor_id').notNull().references(()=>users.id),requestId:uuid('request_id').notNull(),action:varchar('action',{length:32}).notNull(),reason:text('reason'),
 beforeClaim:jsonb('before_claim'),afterClaim:jsonb('after_claim'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('ads_moderation_claim_event_request_uq').on(t.campaignId,t.actorId,t.requestId),index('ads_moderation_claim_events_campaign_idx').on(t.campaignId,t.createdAt)]);
