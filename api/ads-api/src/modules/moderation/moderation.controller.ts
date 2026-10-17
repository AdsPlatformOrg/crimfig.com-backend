import { Controller, Get, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ModerationService } from './moderation.service';
import { IsIn, IsOptional, IsString, IsBoolean } from 'class-validator';

export class ReviewDecisionDto {
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  reasonCode?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class EmergencyOverrideDto {
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @IsString()
  overrideReason: string;
}

export class SuspendPromoterDto {
  @IsBoolean()
  suspend: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Admin Moderation')
@Controller('admin/ads/moderation')
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('queue')
  @ApiOperation({ summary: 'Get queue of pending campaigns and creatives' })
  async getQueue(@Req() req: any) {
    const stage = req.query?.stage as 'reviewer' | 'manager' | undefined;
    const queue = await this.moderationService.getQueue(stage);
    return { status: 'success', data: queue };
  }

  @Post('creatives/:id/decision')
  @ApiOperation({ summary: 'Approve or reject creative asset' })
  async reviewCreative(
    @Param('id') creativeId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user?.sub || req.headers['x-user-id'] || 'admin-reviewer';
    const result = await this.moderationService.reviewCreative(creativeId, {
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @Post('campaigns/:id/primary-review')
  @ApiOperation({ summary: 'Tier-1 primary review by ADS ADMIN Reviewer (under_review -> pending_manager_approval | rejected)' })
  async primaryReviewCampaign(
    @Param('id') campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user?.sub || req.headers['x-user-id'] || 'admin-reviewer-primary';
    const result = await this.moderationService.reviewCampaignPrimary(campaignId, {
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @Post('campaigns/:id/manager-approval')
  @ApiOperation({ summary: 'Tier-2 manager approval by ADS ADMIN Reviewer Manager (pending_manager_approval -> active | rejected)' })
  async managerApprovalCampaign(
    @Param('id') campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user?.sub || req.headers['x-user-id'] || 'admin-reviewer-manager';
    const result = await this.moderationService.reviewCampaignManager(campaignId, {
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @Post('campaigns/:id/emergency-override')
  @ApiOperation({ summary: 'Super Admin emergency override with mandatory documented reason and audit trail' })
  async emergencyOverride(
    @Param('id') campaignId: string,
    @Body() dto: EmergencyOverrideDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user?.sub || req.headers['x-user-id'] || 'super-admin-override';
    const result = await this.moderationService.emergencyOverride(campaignId, {
      reviewerId,
      decision: dto.decision,
      overrideReason: dto.overrideReason,
    });
    return { status: 'success', data: result };
  }

  @Post('campaigns/:id/decision')
  @ApiOperation({ summary: 'Legacy campaign review fallback (calls primary review)' })
  async reviewCampaign(
    @Param('id') campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user?.sub || req.headers['x-user-id'] || 'admin-reviewer';
    const result = await this.moderationService.reviewCampaign(campaignId, {
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @Post('promoters/:id/suspend')
  @ApiOperation({ summary: 'Suspend or unsuspend promoter account' })
  async suspendPromoter(
    @Param('id') promoterId: string,
    @Body() dto: SuspendPromoterDto,
  ) {
    const result = await this.moderationService.setPromoterSuspension(
      promoterId,
      dto.suspend,
      dto.reason,
    );
    return { status: 'success', data: result };
  }
}
