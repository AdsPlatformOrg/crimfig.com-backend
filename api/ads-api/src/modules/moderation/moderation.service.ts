import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CLAIM_POLICY, claimExpiry, activeClaim } from './claim-policy';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsCampaigns,
  adsCreatives,
  adsCreativeStacks,
  adsModerationDecisions,
  adsPromoters,
  adsCampaignSubmissions,
  adsCampaignMutations,
  adsCampaignChanges,
  adsModerationClaims,
  adsModerationClaimEvents,
} from '@crimfig/database/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { CampaignWorkflow, controlRequired, fingerprint, uuidPattern, type ReviewControl } from '../campaigns/campaign-workflow';
import { pendingModerationWork, queueMembership, queueClock, elapsedSeconds } from './moderation-reporting';
import { reviewOptions, knownReviewReason } from './review-policy';
import { AdsStaffGrants } from '../security/ads-staff-grants';

export interface ReviewDecisionParams extends ReviewControl {
  decision: 'approved' | 'rejected';
  reasonCode?: string;
  note?: string;
  advertiserNote?: string;
  internalNote?: string;
  reviewerId: string;
  overrideReason?: string;
}

export interface ClaimParams extends ReviewControl {stage:'reviewer'|'manager';claimId?:string;reason?:string;}

@Injectable()
export class ModerationService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly staffGrants: AdsStaffGrants,
  ) {}

  private get workflow() {
    return new CampaignWorkflow(this.db);
  }

  async getQueue(stage: 'reviewer' | 'manager' = 'reviewer', page = 1) {
    if (!['reviewer', 'manager'].includes(stage)) throw new BadRequestException('Unsupported review stage.');
    if (!Number.isSafeInteger(page) || page < 1 || page > 4000) throw new BadRequestException('Invalid queue page.');
    return this.db.transaction(async tx => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    const status = stage === 'manager' ? 'pending_manager_approval' : 'pending_primary_review';

    const campaigns = await tx
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.moderationStatus, status),
          queueMembership('campaign', sql`${adsCampaigns.id}`, stage),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
          sql`${adsCampaigns.submissionIntentId} IS NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt), desc(adsCampaigns.id))
      .limit(26).offset((page - 1) * 25);

    // Fetch Stacks for review queue
    const stacks = await tx
      .select({
        stack: adsCreativeStacks,
        reviewClock: queueClock('stack',sql`${adsCreativeStacks.id}`,stage),
        campaignTitle: adsCampaigns.title,
        submissionId: adsCampaigns.currentSubmissionId,
        contentRevision: adsCampaigns.contentRevision,
      })
      .from(adsCreativeStacks)
      .innerJoin(adsCampaigns, eq(adsCreativeStacks.campaignId, adsCampaigns.id))
      .where(
        and(
          eq(adsCreativeStacks.archived, false),
          queueMembership('stack',sql`${adsCreativeStacks.id}`,stage),
          stage === 'manager'
            ? eq(adsCreativeStacks.reviewStatus, 'pending_manager_approval')
            : eq(adsCreativeStacks.reviewStatus, 'pending'),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt), desc(adsCreativeStacks.id))
      .limit(26).offset((page - 1) * 25);

    // Fetch Creatives for review queue
    const creatives = await tx
      .select({
        creative: adsCreatives,
        reviewClock: queueClock('creative',sql`${adsCreatives.id}`,stage),
        submissionId: adsCampaigns.currentSubmissionId,
        contentRevision: adsCampaigns.contentRevision,
      })
      .from(adsCreatives)
      .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
      .where(
        and(
          eq(adsCreatives.status, 'active'),
          queueMembership('creative',sql`${adsCreatives.id}`,stage),
          stage === 'manager'
            ? eq(adsCreatives.reviewStatus, 'pending_manager_approval' as any)
            : eq(adsCreatives.reviewStatus, 'pending'),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt), desc(adsCreatives.id))
      .limit(26).offset((page - 1) * 25);

    const campaignClocks = campaigns.length ? await tx.select({id:adsCampaigns.id,reviewClock:queueClock('campaign',sql`${adsCampaigns.id}`,stage)}).from(adsCampaigns).where(sql`${adsCampaigns.id} IN (${sql.join(campaigns.map(c=>sql`${c.id}`),sql`,`)})`) : [];
    // Fetch creative approval counts for each campaign
    const creativeCounts = campaigns.length > 0
      ? await tx
          .select({
            campaignId: adsCreatives.campaignId,
            totalCreatives: sql<number>`count(*)::int`,
            approvedCreatives: sql<number>`count(*) filter (where ${adsCreatives.reviewStatus} = 'approved')::int`,
          })
          .from(adsCreatives)
          .where(and(eq(adsCreatives.status, 'active')))
          .groupBy(adsCreatives.campaignId)
      : [];

    const creativeCountMap = new Map<string, { total: number; approved: number }>();
    for (const row of creativeCounts) {
      creativeCountMap.set(row.campaignId, {
        total: row.totalCreatives || 0,
        approved: row.approvedCreatives || 0,
      });
    }

    return {
      campaigns: campaigns.slice(0, 25).map((c) => {
        const counts = creativeCountMap.get(c.id) || { total: 0, approved: 0 };
        return {
          ...c,
          reviewClock:campaignClocks.find(row=>row.id===c.id)?.reviewClock || null,
          submissionId: c.currentSubmissionId,
          totalCreativesCount: counts.total,
          approvedCreativesCount: counts.approved,
        };
      }),
      stacks: stacks.slice(0, 25).map((s) => ({ ...s.stack, reviewClock:s.reviewClock, campaignTitle: s.campaignTitle, submissionId: s.submissionId, contentRevision: s.contentRevision })),
      creatives: creatives.slice(0, 25).map((r) => ({ ...r.creative, reviewClock:r.reviewClock, submissionId: r.submissionId, contentRevision: r.contentRevision })),
      totalPending: Math.min(25,campaigns.length) + Math.min(25,stacks.length) + Math.min(25,creatives.length),
      asOf:new Date().toISOString(),
      countScope: 'loaded_page', page, pageSize: 25,
      hasMore: { campaigns: campaigns.length > 25, stacks: stacks.length > 25, creatives: creatives.length > 25 },
    };
    });
  }

  private claimsEnabled(){return process.env.ADS_MODERATION_CLAIMS_ENABLED === 'true';}
  private validClaimTarget(type:string,id:string,stage:string){
    if(!['creative','stack','campaign'].includes(type)||!uuidPattern.test(id)||!['reviewer','manager'].includes(stage))throw new BadRequestException('Invalid claim target or review stage.');
  }
  async getClaim(type:string,id:string,stage='reviewer'){
    this.validClaimTarget(type,id,stage);
    if(!this.claimsEnabled())return {enabled:false,serverTime:new Date().toISOString(),policy:CLAIM_POLICY,claim:null};
    return this.db.transaction(async tx=>{
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const clock=await tx.execute(sql`select statement_timestamp() as now`);const now=new Date((clock.rows[0] as {now:Date}).now);
      const [claim]=await tx.select().from(adsModerationClaims).where(and(eq(adsModerationClaims.targetType,type),eq(adsModerationClaims.targetId,id),eq(adsModerationClaims.stage,stage),
        sql`${adsModerationClaims.releasedAt} IS NULL`,sql`${adsModerationClaims.expiresAt} > ${now}`,
        sql`EXISTS(SELECT 1 FROM (${pendingModerationWork()}) w WHERE w.target_type=${type} AND w.target_id=${id} AND w.stage=${stage} AND w.campaign_id=${adsModerationClaims.campaignId} AND w.submission_id=${adsModerationClaims.submissionId} AND w.content_revision=${adsModerationClaims.contentRevision})`)).limit(1);
      return {enabled:true,serverTime:now.toISOString(),policy:CLAIM_POLICY,claim:claim||null};
    });
  }
  async mutateClaim(type:string,id:string,action:'acquire'|'renew'|'release'|'takeover',actorId:string,params:ClaimParams){
    this.validClaimTarget(type,id,params.stage);controlRequired(params);
    if(!uuidPattern.test(params.submissionId||'')||!['acquire','renew','release','takeover'].includes(action))throw new BadRequestException('Current submission and supported claim action required.');
    if(action!=='acquire'&&!uuidPattern.test(params.claimId||''))throw new BadRequestException('A current claim ID is required.');
    if((params.reason?.length||0)>2000)throw new BadRequestException('Claim reason is too long.');
    const roles=this.staffGrants.rolesFor(actorId),admin=roles.includes('ads_admin')||roles.includes('super_admin');
    if(!admin&&!roles.includes(params.stage==='reviewer'?'ads_reviewer':'ads_manager'))throw new ForbiddenException('Your Ads staff role cannot claim this review.');
    if(action==='takeover'&&(!admin||!params.reason?.trim()))throw new ForbiddenException('Administrative takeover requires an administrator and recorded reason.');
    if(!this.claimsEnabled())throw new ServiceUnavailableException('Advisory claims are not enabled. Normal review is still available.');
    let campaignId=id;
    if(type!=='campaign'){
      const table=type==='creative'?adsCreatives:adsCreativeStacks;
      const [parent]=await this.db.select({campaignId:table.campaignId}).from(table).where(eq(table.id,id)).limit(1);
      if(!parent)throw new NotFoundException('Claim target not found.');campaignId=parent.campaignId;
    }
    const hash=fingerprint({type,id,action,...params});
    return this.db.transaction(async tx=>{
      const campaign=await this.workflow.lock(tx,campaignId);
      if(campaign.advertiserId===actorId)throw new ForbiddenException('Owners cannot claim their own campaigns.');
      const [prior]=await tx.select().from(adsCampaignMutations).where(and(eq(adsCampaignMutations.campaignId,campaignId),eq(adsCampaignMutations.actorId,actorId),eq(adsCampaignMutations.requestId,params.requestId))).limit(1);
      if(prior){if(prior.purgedAt||prior.fingerprint!==hash)throw new ConflictException('Claim request identity changed or archived.');return prior.result;}
      if(campaign.currentSubmissionId!==params.submissionId||campaign.contentRevision!==params.expectedRevision||campaign.submissionIntentId)throw new ConflictException('This claim submission changed. Reload details.');
      const table=type==='campaign'?adsCampaigns:type==='creative'?adsCreatives:adsCreativeStacks;
      const [target]=await tx.select().from(table).where(and(eq(table.id,id),'campaignId' in table?eq(table.campaignId,campaignId):eq(table.id,campaignId),queueMembership(type,sql`${table.id}`,params.stage))).limit(1);
      if(!target)throw new ConflictException('This review is no longer pending.');
      if(params.stage==='manager'&&target.primaryReviewerId===actorId&&!admin)throw new ForbiddenException('A different manager must perform Review 2.');
      const clock=await tx.execute(sql`select clock_timestamp() as now`);const now=new Date((clock.rows[0] as {now:Date}).now);
      if(!Number.isFinite(now.getTime()))throw new Error('Authoritative claim clock unavailable.');
      const identity=and(eq(adsModerationClaims.targetType,type),eq(adsModerationClaims.targetId,id),eq(adsModerationClaims.submissionId,params.submissionId),eq(adsModerationClaims.contentRevision,params.expectedRevision),eq(adsModerationClaims.stage,params.stage));
      const [before]=await tx.select().from(adsModerationClaims).where(identity).limit(1);
      const active=activeClaim(before,now);
      let after=before,outcome:string;
      if(action==='acquire'&&active){outcome=before.claimantId===actorId?'held_by_you':'held_by_other';}
      else if(action==='renew'||action==='release'){
        if(!before||before.id!==params.claimId||before.claimantId!==actorId)throw new ForbiddenException('Only the current claimant may renew or release this claim.');
        if(action==='renew'&&!active)throw new ConflictException('Claim expired. Acquire a new claim explicitly.');
        const expiry=claimExpiry(now,before.claimedAt);
        if(action==='renew'&&(expiry<=now||expiry<=before.expiresAt))throw new ConflictException('Claim cannot be extended beyond its 60-minute lifetime.');
        [after]=await tx.update(adsModerationClaims).set(action==='renew'?{expiresAt:expiry}:{releasedAt:before.releasedAt||now}).where(eq(adsModerationClaims.id,before.id)).returning();outcome=action==='renew'?'renewed':'released';
      }else{
        if(action==='takeover'&&(!active||before.id!==params.claimId||before.claimantId===actorId))throw new ConflictException('Takeover requires the current active claim held by another moderator.');
        const values={id:randomUUID(),campaignId,targetType:type,targetId:id,submissionId:params.submissionId,contentRevision:params.expectedRevision,stage:params.stage,claimantId:actorId,claimedAt:now,expiresAt:claimExpiry(now,now),releasedAt:null};
        [after]=before?await tx.update(adsModerationClaims).set(values).where(eq(adsModerationClaims.id,before.id)).returning():await tx.insert(adsModerationClaims).values(values).returning();outcome=action==='takeover'?'taken_over':'acquired';
      }
      if(!after)throw new ConflictException('Claim changed during the request.');
      await tx.insert(adsModerationClaimEvents).values({campaignId,claimId:after.id,actorId,requestId:params.requestId,action:outcome,reason:params.reason?.trim()||null,beforeClaim:before||null,afterClaim:after});
      const result={enabled:true,serverTime:now.toISOString(),policy:CLAIM_POLICY,outcome,claim:action==='release'?null:after};
      await tx.insert(adsCampaignMutations).values({campaignId,actorId,requestId:params.requestId,action:'moderation_claim_'+action,fingerprint:hash,result});
      return result;
    });
  }

  async operationsSummary(targetType='all') {
    if (!['all','creative','stack','campaign'].includes(targetType)) throw new BadRequestException('Unsupported moderation summary scope.');
    const result = await this.db.execute(sql`WITH pending AS (${pendingModerationWork()}),
      scoped AS (SELECT * FROM pending WHERE ${targetType} = 'all' OR target_type = ${targetType}),
      now AS (SELECT statement_timestamp() AS as_of)
      SELECT now.as_of AS "asOf",
        count(*) FILTER (WHERE stage = 'reviewer')::int AS "reviewerCount",
        count(*) FILTER (WHERE stage = 'manager')::int AS "managerCount",
        count(DISTINCT submission_id)::int AS "submissionCount",
        min(submitted_at) FILTER (WHERE submitted_at <= now.as_of) AS "oldestSubmittedAt",
        count(*) FILTER (WHERE target_id IS NOT NULL AND (submitted_at IS NULL OR submitted_at > now.as_of))::int AS "unknownAgeCount"
      FROM now LEFT JOIN scoped ON true GROUP BY now.as_of`);
    const row = result.rows[0] as {asOf:Date|string;reviewerCount:number;managerCount:number;submissionCount:number;oldestSubmittedAt:Date|string|null;unknownAgeCount:number}|undefined;
    if (!row || [row.reviewerCount,row.managerCount,row.submissionCount,row.unknownAgeCount].some(value=>!Number.isSafeInteger(value)||value<0)) throw new Error('Moderation summary unavailable.');
    const asOf=new Date(row.asOf).toISOString();
    return {scope:targetType,asOf,reviewerCount:row.reviewerCount,managerCount:row.managerCount,submissionCount:row.submissionCount,
      oldestSubmittedAt:row.oldestSubmittedAt ? new Date(row.oldestSubmittedAt).toISOString():null,
      oldestAgeSeconds:elapsedSeconds(row.oldestSubmittedAt,asOf),unknownAgeCount:row.unknownAgeCount,
      overdueCount:null,targetStatus:'not_configured' as const};
  }

  async reviewReceipt(campaignId: string, requestId: string, actorId: string) {
    const [receipt] = await this.db.select().from(adsCampaignMutations).where(and(
      eq(adsCampaignMutations.campaignId, campaignId), eq(adsCampaignMutations.actorId, actorId),
      eq(adsCampaignMutations.requestId, requestId))).limit(1);
    if (!receipt || !receipt.action.startsWith('review_')) throw new NotFoundException('Review receipt not found.');
    if (receipt.purgedAt) throw new ConflictException('Review receipt archived. Contact an administrator before retrying.');
    return { requestId, result: receipt.result };
  }

  async itemDetail(type: string, id: string, actorId: string, page = 1) {
    if (!['creative','stack','campaign'].includes(type) || !uuidPattern.test(id)) throw new NotFoundException('Review item not found.');
    if (!Number.isSafeInteger(page) || page < 1 || page > 4000) throw new BadRequestException('Invalid details page.');
    return this.db.transaction(async tx => {
      // A consistent read of the current submission and all related review metadata.
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      let campaignId = id;
      if (type !== 'campaign') {
        const table = type === 'creative' ? adsCreatives : adsCreativeStacks;
        const [child] = await tx.select({ campaignId: table.campaignId }).from(table).where(eq(table.id,id)).limit(1);
        if (!child) throw new NotFoundException('Review item not found.');
        campaignId = child.campaignId;
      }
      const [campaign] = await tx.select().from(adsCampaigns).where(eq(adsCampaigns.id,campaignId)).limit(1);
      if (!campaign) throw new NotFoundException('Campaign not found.');
      const [submission] = campaign.currentSubmissionId ? await tx.select().from(adsCampaignSubmissions).where(eq(adsCampaignSubmissions.id,campaign.currentSubmissionId)).limit(1) : [];
      const current = !!submission && submission.state === 'submitted' && submission.contentRevision === campaign.contentRevision && !campaign.submissionIntentId;
      const snapshot = submission?.snapshot as {campaign?: Record<string, unknown>; stacks?: Record<string, unknown>[]; creatives?: Record<string, unknown>[]; targets?: Record<string, unknown>[]} | undefined;
      const table = type === 'creative' ? adsCreatives : adsCreativeStacks;
      const [child] = type === 'campaign' ? [] : await tx.select().from(table).where(eq(table.id,id)).limit(1);
      const target = type === 'campaign' ? campaign : child;
      const submittedContent = type === 'campaign' ? snapshot?.campaign : (type === 'creative' ? snapshot?.creatives : snapshot?.stacks)?.find(row => row.id === id);
      const content = submittedContent && snapshot?.campaign?.id === campaign.id && (type === 'campaign' || submittedContent.campaignId === campaign.id) ? submittedContent : null;
      const roles = this.staffGrants.rolesFor(actorId);
      const admin = roles.includes('ads_admin') || roles.includes('super_admin');
      const reason = !current || !content ? 'Current immutable submission unavailable. Reload before reviewing.' :
        campaign.advertiserId === actorId ? 'Owners cannot review their own campaigns.' :
        ['suspended','trash','cancelled','completed'].includes(campaign.status) ? 'Campaign lifecycle prevents review.' :
        (type === 'creative' && (!child || !('status' in child) || child.status !== 'active')) || (type === 'stack' && (child && 'archived' in child && child.archived)) ? 'Item is archived or inactive.' : null;
      const state = type === 'campaign' ? campaign.moderationStatus : child?.reviewStatus;
      const capability = (stage: 'reviewer'|'manager') => {
        const role = admin || roles.includes(stage === 'reviewer' ? 'ads_reviewer' : 'ads_manager');
        const stageReady = state === (stage === 'manager' ? 'pending_manager_approval' : type === 'campaign' ? 'pending_primary_review' : 'pending');
        const sameActor = stage === 'manager' && target?.primaryReviewerId === actorId && !admin;
        const blocker = reason || (!role ? 'Your Ads staff role cannot perform this review.' : !stageReady ? 'This item is not pending this review stage.' : sameActor ? 'A different manager must perform Review 2.' : null);
        return { allowed: !blocker, reason: blocker };
      };
      const children = type === 'creative' ? [] : type === 'stack' ? (snapshot?.creatives || []).filter(row => row.adStackId === id) : [...(snapshot?.stacks || []), ...(snapshot?.creatives || [])];
      const history = await tx.select().from(adsModerationDecisions).where(and(eq(adsModerationDecisions.targetType,type as 'creative'|'stack'|'campaign'),eq(adsModerationDecisions.targetId,id))).orderBy(desc(adsModerationDecisions.createdAt),desc(adsModerationDecisions.id)).limit(26).offset((page-1)*25);
      const [progress] = type === 'creative' ? [] : await tx.select({total:sql<number>`count(*)::int`,approved:sql<number>`count(*) filter (where ${adsCreatives.reviewStatus} = 'approved')::int`}).from(adsCreatives).where(and(eq(adsCreatives.campaignId,campaignId),eq(adsCreatives.status,'active'),type === 'stack' ? eq(adsCreatives.adStackId,id) : undefined));
      return { targetType:type, targetId:id, campaign, item:target, content:content || null,
        reviewOptions:reviewOptions(),
        creativeProgress:{total:Number.isSafeInteger(progress?.total)?progress!.total:null,approved:Number.isSafeInteger(progress?.approved)?progress!.approved:null},
        submissionId: current ? submission!.id : null, contentRevision:current ? submission!.contentRevision : null,
        capabilities:{reviewer:capability('reviewer'),manager:capability('manager')},
        children:children.slice((page-1)*25,page*25), targets:snapshot?.targets || [],
        history:history.slice(0,25), page, hasMoreChildren:children.length > page*25, hasMoreHistory:history.length > 25 };
    });
  }

  async submissionDetail(id: string) {
    const [c] = await this.db.select().from(adsCampaigns).where(eq(adsCampaigns.id, id)).limit(1);
    if (!c?.currentSubmissionId) throw new NotFoundException('No current submission.');
    const [submission] = await this.db
      .select()
      .from(adsCampaignSubmissions)
      .where(and(eq(adsCampaignSubmissions.id, c.currentSubmissionId), eq(adsCampaignSubmissions.state, 'submitted')))
      .limit(1);
    if (!submission || submission.contentRevision !== c.contentRevision) {
      throw new ConflictException('This submission changed. Reload the queue.');
    }
    return {
      campaign: c,
      submissionId: submission.id,
      contentRevision: submission.contentRevision,
      snapshot: submission.snapshot,
    };
  }

  async changeAudit(id: string, offset = 0) {
    const rows = await this.db
      .select({
        id: adsCampaignChanges.id,
        actorId: adsCampaignChanges.actorId,
        action: adsCampaignChanges.action,
        requestId: adsCampaignChanges.requestId,
        priorRevision: adsCampaignChanges.priorRevision,
        contentRevision: adsCampaignChanges.contentRevision,
        previousSubmissionId: adsCampaignChanges.previousSubmissionId,
        submissionId: adsCampaignChanges.submissionId,
        beforeHash: adsCampaignChanges.beforeHash,
        afterHash: adsCampaignChanges.afterHash,
        changedFields: adsCampaignChanges.changedFields,
        entityIds: adsCampaignChanges.entityIds,
        createdAt: adsCampaignChanges.createdAt,
      })
      .from(adsCampaignChanges)
      .where(eq(adsCampaignChanges.campaignId, id))
      .orderBy(desc(adsCampaignChanges.createdAt))
      .limit(50)
      .offset(Math.max(0, Math.min(100000, offset)));
    return rows;
  }

  /**
   * Universal moderation decision pipeline enforcing PLAN-0068:
   * - Creatives -> Stacks -> Campaign hierarchy.
   * - No stack approved with 0 approved ads.
   * - No campaign approved with 0 approved stacks.
   * - Dual-reviewer approval required (Review 1 and Review 2).
   * - Auto-live (status = 'active') upon Review 2 campaign approval.
   * - Platform Admin can act as Reviewer 1 and Reviewer 2 sequentially (not in one skip).
   */
  private async decide(
    campaignId: string,
    targetType: 'creative' | 'stack' | 'campaign',
    targetId: string,
    stage: 'primary' | 'manager' | 'override',
    params: ReviewDecisionParams,
  ) {
    controlRequired(params);
    if (!params.submissionId || !uuidPattern.test(params.submissionId)) {
      throw new BadRequestException('A current submission ID is required.');
    }
    if (!['approved', 'rejected'].includes(params.decision)) {
      throw new BadRequestException('Invalid decision.');
    }
    if (params.decision === 'rejected' && ![params.reasonCode,params.note,params.advertiserNote].some(value=>typeof value==='string'&&value.trim().length>0) && stage !== 'override') {
      throw new BadRequestException('A rejection reason or note is required when rejecting.');
    }
    if (
      (params.note?.length ?? 0) > 2000 ||
      (params.advertiserNote?.length ?? 0) > 2000 ||
      (params.internalNote?.length ?? 0) > 2000 ||
      (params.reasonCode?.length ?? 0) > 50
    ) {
      throw new BadRequestException('Review text is too long.');
    }

    const actorRoles = this.staffGrants.rolesFor(params.reviewerId);
    const permitted = stage === 'override' ? actorRoles.includes('super_admin') :
      actorRoles.some(role => role === 'super_admin' || role === 'ads_admin' || role === (stage === 'primary' ? 'ads_reviewer' : 'ads_manager'));
    if (!permitted) throw new ForbiddenException('Your Ads staff role cannot perform this review.');
        const hash = fingerprint({ stage, targetType, targetId, ...params });

    return this.db.transaction(async (tx) => {
      const c = await this.workflow.lock(tx, campaignId);
      if (c.advertiserId === params.reviewerId) {
        throw new BadRequestException('Owners cannot review their own campaigns.');
      }


      const [prior] = await tx
        .select()
        .from(adsCampaignMutations)
        .where(
          and(
            eq(adsCampaignMutations.campaignId, campaignId),
            eq(adsCampaignMutations.actorId, params.reviewerId),
            eq(adsCampaignMutations.requestId, params.requestId),
          ),
        )
        .limit(1);

      if (prior) {
        if (prior.purgedAt) throw new ConflictException('This decision receipt has been archived. Reload the campaign.');
        if (prior.fingerprint !== hash) throw new ConflictException('This decision request changed.');
        return prior.result;
      }

      if (
        c.currentSubmissionId !== params.submissionId ||
        c.contentRevision !== params.expectedRevision ||
        c.submissionIntentId ||
        ['suspended', 'trash', 'cancelled', 'completed'].includes(c.status)
      ) {
        throw new ConflictException('This submission changed. Reload before reviewing.');
      }

      if(stage !== 'override' && params.reasonCode && !knownReviewReason(params.reasonCode)) throw new BadRequestException('Unsupported rejection reason. Use a listed code or omit the code and provide a custom explanation.');

      const [submission] = await tx
        .select()
        .from(adsCampaignSubmissions)
        .where(eq(adsCampaignSubmissions.id, params.submissionId))
        .limit(1);
      if (submission?.state !== 'submitted' || submission.contentRevision !== c.contentRevision) {
        throw new ConflictException('This review is no longer current.');
      }

      // Check Reviewer separation: Platform admin (super_admin / ads_admin) can approve as both Reviewer 1 and Reviewer 2,
      // but must do so in two separate review actions. Standard reviewers must be distinct persons.
      const reviewerRoles = this.staffGrants.rolesFor(params.reviewerId);
      const isPlatformAdmin = reviewerRoles.includes('super_admin') || reviewerRoles.includes('ads_admin');

      const before = await this.workflow.snapshot(tx, c);

      let creativeResult: any = null;
      let stackResult: any = null;

      // 1. Creative Review
      if (targetType === 'creative') {
        const [crt] = await tx
          .select()
          .from(adsCreatives)
          .where(and(eq(adsCreatives.id, targetId), eq(adsCreatives.campaignId, campaignId), eq(adsCreatives.status, 'active')))
          .limit(1);
        if (!crt) throw new NotFoundException('Creative not found in this campaign.');

        if (stage === 'primary') {
          if (crt.reviewStatus !== 'pending') throw new ConflictException('This creative is not pending Review 1.');
          const nextStatus = params.decision === 'approved' ? 'pending_manager_approval' : 'rejected';
          const [updated] = await tx
            .update(adsCreatives)
            .set({
              reviewStatus: nextStatus as any,
              primaryReviewerId: params.reviewerId,
              primaryReviewedAt: new Date(),
              rejectionReason: params.decision === 'rejected' ? params.reasonCode || params.advertiserNote || 'REJECTED' : null,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adsCreatives.id, targetId))
            .returning();
          creativeResult = updated;
        } else if (stage === 'manager' || stage === 'override') {
          if (crt.reviewStatus !== 'pending_manager_approval' && stage !== 'override') {
            throw new ConflictException('This creative is not awaiting Review 2 (Manager Approval).');
          }
          if (stage === 'manager' && crt.primaryReviewerId === params.reviewerId && !isPlatformAdmin) {
            throw new BadRequestException('A different manager must perform Review 2.');
          }
          const nextStatus = params.decision === 'approved' ? 'approved' : 'rejected';
          const [updated] = await tx
            .update(adsCreatives)
            .set({
              reviewStatus: nextStatus as any,
              managerReviewerId: params.reviewerId,
              managerReviewedAt: new Date(),
              rejectionReason: params.decision === 'rejected' ? params.reasonCode || params.advertiserNote || 'REJECTED' : null,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adsCreatives.id, targetId))
            .returning();
          creativeResult = updated;
        }
      }

      // 2. Ad Stack Review
      if (targetType === 'stack') {
        const [stk] = await tx
          .select()
          .from(adsCreativeStacks)
          .where(and(eq(adsCreativeStacks.id, targetId), eq(adsCreativeStacks.campaignId, campaignId), eq(adsCreativeStacks.archived, false)))
          .limit(1);
        if (!stk) throw new NotFoundException('Ad Stack not found in this campaign.');

        // Invariant: An Ad Stack cannot be approved with zero approved ads
        if (params.decision === 'approved') {
          const ads = await tx
            .select()
            .from(adsCreatives)
            .where(and(eq(adsCreatives.adStackId, targetId), eq(adsCreatives.status, 'active')));
          const hasApprovedAd = stage === 'primary'
            ? ads.some((a) => a.reviewStatus === 'pending_manager_approval' || (a.reviewStatus as string) === 'approved')
            : ads.some((a) => (a.reviewStatus as string) === 'approved');
          if (!hasApprovedAd) {
            throw new ConflictException('An Ad Stack cannot be approved with zero approved Ads. Approve ads in this stack first.');
          }
        }

        if (stage === 'primary') {
          if (stk.reviewStatus !== 'pending') throw new ConflictException('This stack is not pending Review 1.');
          const nextStatus = params.decision === 'approved' ? 'pending_manager_approval' : 'rejected';
          const [updated] = await tx
            .update(adsCreativeStacks)
            .set({
              reviewStatus: nextStatus,
              primaryReviewerId: params.reviewerId,
              primaryReviewedAt: new Date(),
              rejectionReason: params.decision === 'rejected' ? params.reasonCode || params.advertiserNote || 'REJECTED' : null,
              updatedAt: new Date(),
            })
            .where(eq(adsCreativeStacks.id, targetId))
            .returning();
          stackResult = updated;
        } else if (stage === 'manager' || stage === 'override') {
          if (stk.reviewStatus !== 'pending_manager_approval' && stage !== 'override') {
            throw new ConflictException('This stack is not awaiting Review 2 (Manager Approval).');
          }
          if (stage === 'manager' && stk.primaryReviewerId === params.reviewerId && !isPlatformAdmin) {
            throw new BadRequestException('A different manager must perform Review 2 on this stack.');
          }
          const nextStatus = params.decision === 'approved' ? 'approved' : 'rejected';
          const [updated] = await tx
            .update(adsCreativeStacks)
            .set({
              reviewStatus: nextStatus,
              managerReviewerId: params.reviewerId,
              managerReviewedAt: new Date(),
              rejectionReason: params.decision === 'rejected' ? params.reasonCode || params.advertiserNote || 'REJECTED' : null,
              updatedAt: new Date(),
            })
            .where(eq(adsCreativeStacks.id, targetId))
            .returning();
          stackResult = updated;
        }
      }

      // 3. Campaign Review
      let updatedCampaign = c;
      if (targetType === 'campaign') {
        const expectedStatus = stage === 'manager' ? 'pending_manager_approval' : 'pending_primary_review';
        if (stage !== 'override' && c.moderationStatus !== expectedStatus) {
          throw new ConflictException('This campaign review stage changed. Reload before deciding.');
        }

        // Invariant: Campaign cannot be approved with zero approved creatives across all its stacks
        if (params.decision === 'approved') {
          const ads = await tx
            .select()
            .from(adsCreatives)
            .where(and(eq(adsCreatives.campaignId, campaignId), eq(adsCreatives.status, 'active')));
          const hasApprovedAd = stage === 'primary'
            ? ads.some((a) => a.reviewStatus === 'pending_manager_approval' || (a.reviewStatus as string) === 'approved')
            : ads.some((a) => (a.reviewStatus as string) === 'approved');

          if (!hasApprovedAd) {
            throw new ConflictException('A campaign cannot be approved with zero approved Ads. Approve at least one creative first.');
          }
        }

        if (stage === 'primary') {
          const nextModeration = params.decision === 'approved' ? 'pending_manager_approval' : 'rejected';
          const nextStatus = params.decision === 'approved' ? c.status : 'rejected';
          [updatedCampaign] = await tx
            .update(adsCampaigns)
            .set({
              moderationStatus: nextModeration,
              status: nextStatus,
              primaryReviewerId: params.reviewerId,
              primaryReviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(adsCampaigns.id, campaignId))
            .returning();
        } else if (stage === 'manager' || stage === 'override') {
          if (stage === 'manager' && c.primaryReviewerId === params.reviewerId && !isPlatformAdmin) {
            throw new BadRequestException('A different reviewer and manager are required for campaign approval.');
          }
          const approved = params.decision === 'approved';
          // PLAN-0068: Campaign automatically goes LIVE (status = 'active') once approved by Reviewer 2
          const nextStatus = approved ? 'active' : 'rejected';
          const nextModeration = approved ? 'approved' : 'rejected';

          [updatedCampaign] = await tx
            .update(adsCampaigns)
            .set({
              moderationStatus: nextModeration,
              status: nextStatus,
              managerReviewerId: params.reviewerId,
              managerReviewedAt: new Date(),
              approvedSubmissionId: approved ? params.submissionId : null,
              approvedRevision: approved ? c.contentRevision : null,
              updatedAt: new Date(),
            })
            .where(eq(adsCampaigns.id, campaignId))
            .returning();
        }
      }

      // Record immutable decision audit
      const [decision] = await tx
        .insert(adsModerationDecisions)
        .values({
          targetType,
          targetId,
          reviewerId: params.reviewerId,
          decision: params.decision,
          reasonCode: stage === 'override' ? 'SUPER_ADMIN_EMERGENCY_OVERRIDE' : params.reasonCode || null,
          note: params.note || null,
          advertiserNote: params.advertiserNote || null,
          internalNote: params.internalNote || null,
          submissionId: params.submissionId,
          contentRevision: c.contentRevision,
          stage,
          requestId: params.requestId,
          isEmergencyOverride: stage === 'override',
          overrideReason: params.overrideReason || null,
        })
        .returning();

      const after = await this.workflow.snapshot(tx, updatedCampaign);
      await this.workflow.audit(
        tx,
        before,
        after,
        params.reviewerId,
        `review_${targetType}_${stage}_${params.decision}`,
        params.requestId,
        [targetType === 'campaign' ? 'moderationStatus' : `${targetType}:${targetId}:reviewStatus`],
      );

      const output = {
        targetType,
        targetId,
        decision,
        campaign: updatedCampaign,
        creative: creativeResult,
        stack: stackResult,
        stage,
        nextStage: updatedCampaign.moderationStatus,
        live: updatedCampaign.status === 'active',
      };

      await tx.insert(adsCampaignMutations).values({
        campaignId,
        actorId: params.reviewerId,
        requestId: params.requestId,
        action: `review_${targetType}_${stage}`,
        fingerprint: hash,
        result: output,
      });

      return output;
    });
  }

  // Creative Review Handlers
  reviewCreativePrimary(id: string, params: ReviewDecisionParams) {
    return this.findCreativeAndDecide(id, 'primary', params);
  }
  reviewCreativeManager(id: string, params: ReviewDecisionParams) {
    return this.findCreativeAndDecide(id, 'manager', params);
  }
  reviewCreative(id: string, params: ReviewDecisionParams) {
    return this.reviewCreativePrimary(id, params);
  }

  // Stack Review Handlers
  reviewStackPrimary(id: string, params: ReviewDecisionParams) {
    return this.findStackAndDecide(id, 'primary', params);
  }
  reviewStackManager(id: string, params: ReviewDecisionParams) {
    return this.findStackAndDecide(id, 'manager', params);
  }

  // Campaign Review Handlers
  reviewCampaignPrimary(id: string, params: ReviewDecisionParams) {
    return this.decide(id, 'campaign', id, 'primary', params);
  }
  reviewCampaignManager(id: string, params: ReviewDecisionParams) {
    return this.decide(id, 'campaign', id, 'manager', params);
  }
  reviewCampaign(id: string, params: ReviewDecisionParams) {
    return this.reviewCampaignPrimary(id, params);
  }
  emergencyOverride(id: string, params: ReviewDecisionParams) {
    return this.decide(id, 'campaign', id, 'override', params);
  }

  private async findCreativeAndDecide(id: string, stage: 'primary' | 'manager', params: ReviewDecisionParams) {
    const [ad] = await this.db.select({ campaignId: adsCreatives.campaignId }).from(adsCreatives).where(eq(adsCreatives.id, id)).limit(1);
    if (!ad) throw new NotFoundException('Creative not found.');
    return this.decide(ad.campaignId, 'creative', id, stage, params);
  }

  private async findStackAndDecide(id: string, stage: 'primary' | 'manager', params: ReviewDecisionParams) {
    const [stk] = await this.db.select({ campaignId: adsCreativeStacks.campaignId }).from(adsCreativeStacks).where(eq(adsCreativeStacks.id, id)).limit(1);
    if (!stk) throw new NotFoundException('Ad Stack not found.');
    return this.decide(stk.campaignId, 'stack', id, stage, params);
  }

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
