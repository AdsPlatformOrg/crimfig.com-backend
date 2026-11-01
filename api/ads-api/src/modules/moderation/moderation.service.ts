import { Injectable, Inject, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
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
} from '@crimfig/database/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { CampaignWorkflow, controlRequired, fingerprint, uuidPattern, type ReviewControl } from '../campaigns/campaign-workflow';
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

@Injectable()
export class ModerationService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly staffGrants: AdsStaffGrants,
  ) {}

  private get workflow() {
    return new CampaignWorkflow(this.db);
  }

  async getQueue(stage: 'reviewer' | 'manager' = 'reviewer') {
    if (!['reviewer', 'manager'].includes(stage)) throw new BadRequestException('Unsupported review stage.');
    const status = stage === 'manager' ? 'pending_manager_approval' : 'pending_primary_review';

    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(
        and(
          eq(adsCampaigns.moderationStatus, status),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
          sql`${adsCampaigns.submissionIntentId} IS NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt))
      .limit(50);

    // Fetch Stacks for review queue
    const stacks = await this.db
      .select({
        stack: adsCreativeStacks,
        campaignTitle: adsCampaigns.title,
        submissionId: adsCampaigns.currentSubmissionId,
        contentRevision: adsCampaigns.contentRevision,
      })
      .from(adsCreativeStacks)
      .innerJoin(adsCampaigns, eq(adsCreativeStacks.campaignId, adsCampaigns.id))
      .where(
        and(
          eq(adsCreativeStacks.archived, false),
          stage === 'manager'
            ? eq(adsCreativeStacks.reviewStatus, 'pending_manager_approval')
            : eq(adsCreativeStacks.reviewStatus, 'pending'),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt))
      .limit(100);

    // Fetch Creatives for review queue
    const creatives = await this.db
      .select({
        creative: adsCreatives,
        submissionId: adsCampaigns.currentSubmissionId,
        contentRevision: adsCampaigns.contentRevision,
      })
      .from(adsCreatives)
      .innerJoin(adsCampaigns, eq(adsCreatives.campaignId, adsCampaigns.id))
      .where(
        and(
          eq(adsCreatives.status, 'active'),
          stage === 'manager'
            ? eq(adsCreatives.reviewStatus, 'pending_manager_approval' as any)
            : eq(adsCreatives.reviewStatus, 'pending'),
          sql`${adsCampaigns.currentSubmissionId} IS NOT NULL`,
        ),
      )
      .orderBy(desc(adsCampaigns.submittedAt))
      .limit(100);

    // Fetch creative approval counts for each campaign
    const creativeCounts = campaigns.length > 0
      ? await this.db
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
      campaigns: campaigns.map((c) => {
        const counts = creativeCountMap.get(c.id) || { total: 0, approved: 0 };
        return {
          ...c,
          submissionId: c.currentSubmissionId,
          totalCreativesCount: counts.total,
          approvedCreativesCount: counts.approved,
        };
      }),
      stacks: stacks.map((s) => ({ ...s.stack, campaignTitle: s.campaignTitle, submissionId: s.submissionId, contentRevision: s.contentRevision })),
      creatives: creatives.map((r) => ({ ...r.creative, submissionId: r.submissionId, contentRevision: r.contentRevision })),
      totalPending: campaigns.length + stacks.length + creatives.length,
    };
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
    if (params.decision === 'rejected' && !params.reasonCode && !params.note && !params.advertiserNote && stage !== 'override') {
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

    const hash = fingerprint({ stage, targetType, targetId, ...params });

    return this.db.transaction(async (tx) => {
      const c = await this.workflow.lock(tx, campaignId);
      if (c.advertiserId === params.reviewerId) {
        throw new BadRequestException('Owners cannot review their own campaigns.');
      }
      if (
        c.currentSubmissionId !== params.submissionId ||
        c.contentRevision !== params.expectedRevision ||
        c.submissionIntentId ||
        ['suspended', 'trash', 'cancelled', 'completed'].includes(c.status)
      ) {
        throw new ConflictException('This submission changed. Reload before reviewing.');
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
          note: params.note || params.internalNote || null,
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
