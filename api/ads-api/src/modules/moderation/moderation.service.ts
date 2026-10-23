import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsCampaigns,
  adsCreatives,
  adsModerationDecisions,
  adsPromoters,
} from '@crimfig/database/schema';
import { eq, desc, and } from 'drizzle-orm';

export interface ReviewDecisionParams {
  decision: 'approved' | 'rejected';
  reasonCode?: string;
  note?: string;
  reviewerId: string;
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get queue of items pending compliance / moderation review
   */
  async getQueue(stage?: 'reviewer' | 'manager') {
    let statusFilter = eq(adsCampaigns.moderationStatus, 'pending_primary_review');
    if (stage === 'manager') {
      statusFilter = eq(adsCampaigns.moderationStatus, 'pending_manager_approval');
    }

    const pendingCampaigns = await this.db
      .select({
        id: adsCampaigns.id,
        advertiserId: adsCampaigns.advertiserId,
        title: adsCampaigns.title,
        status: adsCampaigns.status,
        moderationStatus: adsCampaigns.moderationStatus,
        pricingModel: adsCampaigns.pricingModel,
        budgetUsdCents: adsCampaigns.budgetUsdCents,
        createdAt: adsCampaigns.createdAt,
      })
      .from(adsCampaigns)
      .where(stage ? statusFilter : and(eq(adsCampaigns.moderationStatus, 'pending_primary_review')))
      .orderBy(desc(adsCampaigns.createdAt))
      .limit(50);

    const pendingCreatives = await this.db
      .select({
        id: adsCreatives.id,
        campaignId: adsCreatives.campaignId,
        headline: adsCreatives.headline,
        bodyText: adsCreatives.bodyText,
        ctaText: adsCreatives.ctaText,
        imageUrl: adsCreatives.imageUrl,
        videoUrl: adsCreatives.videoUrl,
        destinationUrl: adsCreatives.destinationUrl,
        mediaFormat: adsCreatives.mediaFormat,
        adFormat: adsCreatives.adFormat,
        reviewStatus: adsCreatives.reviewStatus,
        createdAt: adsCreatives.createdAt,
      })
      .from(adsCreatives)
      .where(eq(adsCreatives.reviewStatus, 'pending'))
      .orderBy(desc(adsCreatives.createdAt))
      .limit(50);

    return {
      campaigns: pendingCampaigns,
      creatives: pendingCreatives,
      totalPending: pendingCampaigns.length + pendingCreatives.length,
    };
  }

  /**
   * Submit moderation decision for a creative asset
   */
  async reviewCreative(creativeId: string, params: ReviewDecisionParams) {
    const [creative] = await this.db
      .select()
      .from(adsCreatives)
      .where(eq(adsCreatives.id, creativeId))
      .limit(1);

    if (!creative) {
      throw new NotFoundException('Creative not found');
    }

    const [ownerCampaign] = await this.db.select().from(adsCampaigns).where(eq(adsCampaigns.id, creative.campaignId)).limit(1);
    if (!ownerCampaign) throw new NotFoundException('Campaign not found');
    if (ownerCampaign.advertiserId === params.reviewerId) throw new BadRequestException('Creative owners cannot review their own assets');

    if (params.decision === 'rejected' && !params.reasonCode) {
      throw new BadRequestException('A reasonCode is mandatory when rejecting a creative');
    }

    // Record formal audit decision
    const [decisionRecord] = await this.db
      .insert(adsModerationDecisions)
      .values({
        targetType: 'creative',
        targetId: creativeId,
        reviewerId: params.reviewerId,
        decision: params.decision,
        reasonCode: params.reasonCode || null,
        note: params.note || null,
      })
      .returning();

    // Update creative status
    const [updatedCreative] = await this.db
      .update(adsCreatives)
      .set({
        reviewStatus: params.decision,
        rejectionReason: params.decision === 'rejected' ? params.reasonCode : null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsCreatives.id, creativeId))
      .returning();

    return {
      creative: updatedCreative,
      decision: decisionRecord,
    };
  }

  /**
   * Tier-1 Primary Review: by ads_reviewer
   * Transitions campaign: moderationStatus 'pending_primary_review' -> 'pending_manager_approval' or 'rejected'
   */
  async reviewCampaignPrimary(campaignId: string, params: ReviewDecisionParams) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.advertiserId === params.reviewerId) throw new BadRequestException('Campaign owners cannot review their own campaigns');

    if (campaign.moderationStatus !== 'pending_primary_review' && campaign.status !== 'under_review') {
      throw new BadRequestException(
        `Campaign cannot undergo primary review from moderation status '${campaign.moderationStatus}'. Expected 'pending_primary_review'.`,
      );
    }

    const nextModStatus = params.decision === 'approved' ? 'pending_manager_approval' : 'rejected';

    const [decisionRecord] = await this.db
      .insert(adsModerationDecisions)
      .values({
        targetType: 'campaign',
        targetId: campaignId,
        reviewerId: params.reviewerId,
        decision: params.decision,
        reasonCode: params.reasonCode || 'TIER1_PRIMARY_REVIEW',
        note: params.note ? `[Tier-1 Primary Review] ${params.note}` : '[Tier-1 Primary Review]',
      })
      .returning();

    const [updatedCampaign] = await this.db
      .update(adsCampaigns)
      .set({
        moderationStatus: nextModStatus,
        status: nextModStatus === 'rejected' ? 'rejected' : campaign.status,
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, campaignId))
      .returning();

    return {
      campaign: updatedCampaign,
      decision: decisionRecord,
      stage: 'tier1_primary_completed',
      nextStage: nextModStatus === 'pending_manager_approval' ? 'manager_approval_required' : 'archived_rejected',
    };
  }

  /**
   * Tier-2 Manager Sign-off: by ads_manager
   * Transitions campaign: moderationStatus 'pending_manager_approval' -> 'approved' or 'rejected'
   * If approved: operational status transitions to 'active' (Eligible for ad serving auction)
   * Strictly enforces Segregation of Duties: Manager cannot be the Primary Reviewer.
   */
  async reviewCampaignManager(campaignId: string, params: ReviewDecisionParams) {
    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.advertiserId === params.reviewerId) throw new BadRequestException('Campaign owners cannot approve their own campaigns');

    if (campaign.moderationStatus !== 'pending_manager_approval' && campaign.status !== 'pending_manager_approval') {
      throw new BadRequestException(
        `Campaign cannot undergo manager sign-off from moderation status '${campaign.moderationStatus}'. Expected 'pending_manager_approval'.`,
      );
    }

    // Verify segregation of duties: Primary reviewer != Reviewer Manager
    const [primaryDecision] = await this.db
      .select()
      .from(adsModerationDecisions)
      .where(
        and(
          eq(adsModerationDecisions.targetType, 'campaign'),
          eq(adsModerationDecisions.targetId, campaignId),
          eq(adsModerationDecisions.decision, 'approved'),
        ),
      )
      .orderBy(desc(adsModerationDecisions.createdAt))
      .limit(1);

    if (primaryDecision && primaryDecision.reviewerId === params.reviewerId) {
      throw new BadRequestException(
        'Segregation of duties violation: The Reviewer Manager cannot be the same user who performed the primary review.',
      );
    }

    const nextModStatus = params.decision === 'approved' ? 'approved' : 'rejected';
    // Approval permits activation; Billing must atomically confirm funding and status.
    const nextOpStatus = params.decision === 'approved' ? 'paused' : 'rejected';

    const [decisionRecord] = await this.db
      .insert(adsModerationDecisions)
      .values({
        targetType: 'campaign',
        targetId: campaignId,
        reviewerId: params.reviewerId,
        decision: params.decision,
        reasonCode: params.reasonCode || 'TIER2_MANAGER_SIGNOFF',
        note: params.note ? `[Tier-2 Manager Approval] ${params.note}` : '[Tier-2 Manager Approval]',
      })
      .returning();

    const [updatedCampaign] = await this.db
      .update(adsCampaigns)
      .set({
        moderationStatus: nextModStatus,
        status: nextOpStatus,
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, campaignId))
      .returning();

    return {
      campaign: updatedCampaign,
      decision: decisionRecord,
      stage: 'tier2_manager_completed',
      live: false,
    };
  }

  /**
   * Super Admin Emergency Override
   * Bypasses dual review only in emergencies with mandatory documented reason and immutable audit log.
   */
  async emergencyOverride(campaignId: string, params: { reviewerId: string; decision: 'approved' | 'rejected'; overrideReason: string }) {
    if (!params.overrideReason || params.overrideReason.trim().length < 10) {
      throw new BadRequestException('A substantive overrideReason (minimum 10 characters) is mandatory for emergency super_admin override.');
    }

    const [campaign] = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.id, campaignId))
      .limit(1);

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    const nextModStatus = params.decision === 'approved' ? 'approved' : 'rejected';
    // Approval permits activation; Billing must atomically confirm funding and status.
    const nextOpStatus = params.decision === 'approved' ? 'paused' : 'rejected';

    const [decisionRecord] = await this.db
      .insert(adsModerationDecisions)
      .values({
        targetType: 'campaign',
        targetId: campaignId,
        reviewerId: params.reviewerId,
        decision: params.decision,
        reasonCode: 'SUPER_ADMIN_EMERGENCY_OVERRIDE',
        note: `[EMERGENCY OVERRIDE] ${params.overrideReason}`,
        isEmergencyOverride: true,
        overrideReason: params.overrideReason,
      })
      .returning();

    const [updatedCampaign] = await this.db
      .update(adsCampaigns)
      .set({
        moderationStatus: nextModStatus,
        status: nextOpStatus,
        updatedAt: new Date(),
      })
      .where(eq(adsCampaigns.id, campaignId))
      .returning();

    return {
      campaign: updatedCampaign,
      decision: decisionRecord,
      isEmergencyOverride: true,
      live: false,
    };
  }

  /**
   * Submit moderation decision for an ad campaign (legacy single-step shim fallback)
   */
  async reviewCampaign(campaignId: string, params: ReviewDecisionParams) {
    return this.reviewCampaignPrimary(campaignId, params);
  }

  /**
   * Suspend or unsuspend a promoter profile
   */
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
