import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsCampaigns, adsCreatives, adsModerationDecisions, adsPromoters, adsCampaignSubmissions, adsCampaignMutations, adsCampaignChanges } from '@crimfig/database/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { CampaignWorkflow, controlRequired, fingerprint, uuidPattern, type ReviewControl } from '../campaigns/campaign-workflow';
export interface ReviewDecisionParams extends ReviewControl {
  decision:'approved'|'rejected'; reasonCode?:string; note?:string; reviewerId:string; overrideReason?:string;
}
@Injectable()
export class ModerationService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db:NodePgDatabase<typeof schema>) {}
  private get workflow() { return new CampaignWorkflow(this.db); }
  async getQueue(stage:'reviewer'|'manager'='reviewer') {
    if(!['reviewer','manager'].includes(stage)) throw new BadRequestException('Unsupported review stage.');
    const status=stage==='manager'?'pending_manager_approval':'pending_primary_review';
    const campaigns=await this.db.select().from(adsCampaigns).where(and(eq(adsCampaigns.moderationStatus,status),sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,sql`${adsCampaigns.submissionIntentId} IS NULL`)).orderBy(desc(adsCampaigns.submittedAt)).limit(50);
    const rows=stage==='manager'?[]:await this.db.select({creative:adsCreatives,submissionId:adsCampaigns.currentSubmissionId,contentRevision:adsCampaigns.contentRevision}).from(adsCreatives)
      .innerJoin(adsCampaigns,eq(adsCreatives.campaignId,adsCampaigns.id)).where(and(eq(adsCampaigns.moderationStatus,'pending_primary_review'),sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,eq(adsCreatives.reviewStatus,'pending'),eq(adsCreatives.status,'active'))).orderBy(desc(adsCampaigns.submittedAt)).limit(100);
    return {campaigns:campaigns.map(c=>({...c,submissionId:c.currentSubmissionId})),creatives:rows.map(r=>({...r.creative,submissionId:r.submissionId,contentRevision:r.contentRevision})),totalPending:campaigns.length+rows.length};
  }
  async submissionDetail(id:string) {
    const [c]=await this.db.select().from(adsCampaigns).where(eq(adsCampaigns.id,id)).limit(1);
    if(!c?.currentSubmissionId) throw new NotFoundException('No current submission.');
    const [submission]=await this.db.select().from(adsCampaignSubmissions).where(and(eq(adsCampaignSubmissions.id,c.currentSubmissionId),eq(adsCampaignSubmissions.state,'submitted'))).limit(1);
    if(!submission || submission.contentRevision!==c.contentRevision) throw new ConflictException('This submission changed. Reload the queue.');
    // Current full immutable content only. No edit history/diffs for ordinary reviewers.
    return {campaign:c,submissionId:submission.id,contentRevision:submission.contentRevision,snapshot:submission.snapshot};
  }
  async changeAudit(id:string,offset=0) {
    const rows=await this.db.select({id:adsCampaignChanges.id,actorId:adsCampaignChanges.actorId,action:adsCampaignChanges.action,requestId:adsCampaignChanges.requestId,
      priorRevision:adsCampaignChanges.priorRevision,contentRevision:adsCampaignChanges.contentRevision,previousSubmissionId:adsCampaignChanges.previousSubmissionId,submissionId:adsCampaignChanges.submissionId,
      beforeHash:adsCampaignChanges.beforeHash,afterHash:adsCampaignChanges.afterHash,changedFields:adsCampaignChanges.changedFields,entityIds:adsCampaignChanges.entityIds,createdAt:adsCampaignChanges.createdAt})
      .from(adsCampaignChanges).where(eq(adsCampaignChanges.campaignId,id)).orderBy(desc(adsCampaignChanges.createdAt)).limit(50).offset(Math.max(0,Math.min(100000,offset)));
    return rows;
  }
  private async decide(campaignId:string,creativeId:string|null,stage:'primary'|'manager'|'creative'|'override',params:ReviewDecisionParams) {
    controlRequired(params);
    if(!params.submissionId || !uuidPattern.test(params.submissionId)) throw new BadRequestException('A current submission ID is required.');
    if(!['approved','rejected'].includes(params.decision)) throw new BadRequestException('Invalid decision.');
    if(params.decision==='rejected' && !params.reasonCode && stage!=='override') throw new BadRequestException('A rejection reason is required.');
    if((params.note?.length??0)>2000 || (params.reasonCode?.length??0)>50) throw new BadRequestException('Review text is too long.');
    if(stage==='override' && (params.overrideReason?.trim().length??0)<10) throw new BadRequestException('Explain the emergency override in at least 10 characters.');
    const hash=fingerprint({stage,creativeId,...params});
    return this.db.transaction(async(tx)=>{
      const c=await this.workflow.lock(tx,campaignId);
      if(c.advertiserId===params.reviewerId) throw new BadRequestException('Owners cannot review their own campaigns.');
      if(c.currentSubmissionId!==params.submissionId || c.contentRevision!==params.expectedRevision || c.submissionIntentId || ['suspended','trash','cancelled','completed','draft'].includes(c.status)) throw new ConflictException('This submission changed. Reload before reviewing.');
      const [prior]=await tx.select().from(adsCampaignMutations).where(and(eq(adsCampaignMutations.campaignId,campaignId),eq(adsCampaignMutations.actorId,params.reviewerId),eq(adsCampaignMutations.requestId,params.requestId))).limit(1);
      if(prior) {if(prior.purgedAt)throw new ConflictException('This decision receipt has been archived. Reload the campaign.');if(prior.fingerprint!==hash) throw new ConflictException('This decision request changed.');return prior.result;}
      const [submission]=await tx.select().from(adsCampaignSubmissions).where(eq(adsCampaignSubmissions.id,params.submissionId)).limit(1);
      if(submission?.state!=='submitted'||submission.contentRevision!==c.contentRevision) throw new ConflictException('This review is no longer current.');
      const expected=stage==='manager'?'pending_manager_approval':'pending_primary_review';
      if(stage!=='override' && c.moderationStatus!==expected) throw new ConflictException('This review stage changed. Reload the submission.');
      if(stage==='override' && !['pending_primary_review','pending_manager_approval'].includes(c.moderationStatus)) throw new ConflictException('Only a current submitted review can be overridden.');
      if(stage==='manager' && (!c.primaryReviewerId || c.primaryReviewerId===params.reviewerId)) throw new BadRequestException('A different primary reviewer and manager are required for this submission.');
      const before=await this.workflow.snapshot(tx,c);
      let creative:any;
      if(stage==='creative') {
        const [current]=await tx.select().from(adsCreatives).where(and(eq(adsCreatives.id,creativeId!),eq(adsCreatives.campaignId,campaignId),eq(adsCreatives.status,'active'))).limit(1);
        if(!current || current.reviewStatus!=='pending') throw new ConflictException('This creative is no longer pending.');
        [creative]=await tx.update(adsCreatives).set({reviewStatus:params.decision,rejectionReason:params.decision==='rejected'?params.reasonCode:null,reviewedAt:new Date(),updatedAt:new Date()}).where(eq(adsCreatives.id,creativeId!)).returning();
      }
      if(stage!=='creative' && params.decision==='approved') {
        const ads=await tx.select().from(adsCreatives).where(and(eq(adsCreatives.campaignId,campaignId),eq(adsCreatives.status,'active')));
        if(!ads.length || ads.some(a=>a.reviewStatus!=='approved')) throw new ConflictException('Review all current creatives before approving the campaign.');
      }
      const [decision]=await tx.insert(adsModerationDecisions).values({targetType:creativeId?'creative':'campaign',targetId:creativeId||campaignId,reviewerId:params.reviewerId,
        decision:params.decision,reasonCode:stage==='override'?'SUPER_ADMIN_EMERGENCY_OVERRIDE':params.reasonCode||null,note:params.note||null,
        submissionId:params.submissionId,contentRevision:c.contentRevision,stage,requestId:params.requestId,isEmergencyOverride:stage==='override',overrideReason:params.overrideReason||null}).returning();
      let updated=c;
      if(stage!=='creative') {
        const approved=params.decision==='approved';const final=stage==='manager'||stage==='override';
        [updated]=await tx.update(adsCampaigns).set({moderationStatus:approved?(final?'approved':'pending_manager_approval'):'rejected',status:approved?'paused':'rejected',
          ...(stage==='primary'?{primaryReviewerId:params.reviewerId,primaryReviewedAt:new Date()}:{}),
          ...(final?{managerReviewerId:params.reviewerId,managerReviewedAt:new Date(),approvedSubmissionId:approved?params.submissionId:null,approvedRevision:approved?c.contentRevision:null}:{}),updatedAt:new Date()}).where(eq(adsCampaigns.id,campaignId)).returning();
      }
      const after=await this.workflow.snapshot(tx,updated);
      await this.workflow.audit(tx,before,after,params.reviewerId,`review_${stage}_${params.decision}`,params.requestId,[creativeId?`creative:${creativeId}:reviewStatus`:'moderationStatus']);
      const output=creativeId?{creative,decision}:{campaign:updated,decision,stage,nextStage:updated.moderationStatus,live:false,isEmergencyOverride:stage==='override'};
      await tx.insert(adsCampaignMutations).values({campaignId,actorId:params.reviewerId,requestId:params.requestId,action:`review_${stage}`,fingerprint:hash,result:output});return output;
    });
  }
  async reviewCreative(id:string,params:ReviewDecisionParams) {
    const [ad]=await this.db.select({campaignId:adsCreatives.campaignId}).from(adsCreatives).where(eq(adsCreatives.id,id)).limit(1);
    if(!ad) throw new NotFoundException('Creative not found.');return this.decide(ad.campaignId,id,'creative',params);
  }
  reviewCampaignPrimary(id:string,params:ReviewDecisionParams) {return this.decide(id,null,'primary',params);}
  reviewCampaignManager(id:string,params:ReviewDecisionParams) {return this.decide(id,null,'manager',params);}
  reviewCampaign(id:string,params:ReviewDecisionParams) {return this.reviewCampaignPrimary(id,params);}
  emergencyOverride(id:string,params:ReviewDecisionParams) {return this.decide(id,null,'override',params);}
  async setPromoterSuspension(promoterId: string, suspend: boolean, reason?: string) {
    const [updated] = await this.db
      .update(adsPromoters)
      .set({
        isSuspended: suspend,
        updatedAt: new Date(),
      })
      .where(eq(adsPromoters.id, promoterId))
      .returning();

    if (!updated) {
      throw new NotFoundException('Promoter not found');
    }

    return updated;
  }
}
