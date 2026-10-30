import { MutationDto } from '../campaigns/campaigns.controller';
import { IsUUID } from 'class-validator';
import { AdsRoles } from '../security/ads-staff-grants';
import { Controller, Get, Post, Body, Param, Req, UseGuards, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ModerationService } from './moderation.service';
import { IsIn, IsOptional, IsString, IsBoolean } from 'class-validator';
import { documentAdsController } from '../../contracts/ads-contract';

export class ReviewDecisionDto extends MutationDto {
  @IsUUID() submissionId:string;
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  reasonCode?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class EmergencyOverrideDto extends MutationDto {
  @IsUUID() submissionId:string;
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
@AdsRoles('ads_admin', 'ads_reviewer', 'ads_manager', 'ads_support', 'super_admin')
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

  @Get('campaigns/:id/submission')
  async submissionDetail(@Param('id',new ParseUUIDPipe()) id:string) {return {status:'success',data:await this.moderationService.submissionDetail(id)};}

  @AdsRoles('super_admin')
  @Get('campaigns/:id/change-audit')
  async changeAudit(@Param('id',new ParseUUIDPipe()) id:string,@Query('offset') offset?:string) {return {status:'success',data:await this.moderationService.changeAudit(id, Number(offset)||0)};}

  @AdsRoles('ads_reviewer')
  @Post('creatives/:id/decision')
  @ApiOperation({ summary: 'Approve or reject creative asset' })
  async reviewCreative(
    @Param('id',new ParseUUIDPipe()) creativeId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user.sub;
    const result = await this.moderationService.reviewCreative(creativeId, {
      ...dto,
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_reviewer')
  @Post('campaigns/:id/primary-review')
  @ApiOperation({ summary: 'Tier-1 primary review by ADS ADMIN Reviewer (under_review -> pending_manager_approval | rejected)' })
  async primaryReviewCampaign(
    @Param('id',new ParseUUIDPipe()) campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user.sub;
    const result = await this.moderationService.reviewCampaignPrimary(campaignId, {
      ...dto,
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_manager')
  @Post('campaigns/:id/manager-approval')
  @ApiOperation({ summary: 'Tier-2 manager approval by ADS ADMIN Reviewer Manager (pending_manager_approval -> active | rejected)' })
  async managerApprovalCampaign(
    @Param('id',new ParseUUIDPipe()) campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user.sub;
    const result = await this.moderationService.reviewCampaignManager(campaignId, {
      ...dto,
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles('super_admin')
  @Post('campaigns/:id/emergency-override')
  @ApiOperation({ summary: 'Super Admin emergency override with mandatory documented reason and audit trail' })
  async emergencyOverride(
    @Param('id',new ParseUUIDPipe()) campaignId: string,
    @Body() dto: EmergencyOverrideDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user.sub;
    const result = await this.moderationService.emergencyOverride(campaignId, {
      reviewerId,
      ...dto,
      decision: dto.decision,
      overrideReason: dto.overrideReason,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_reviewer')
  @Post('campaigns/:id/decision')
  @ApiOperation({ summary: 'Legacy campaign review fallback (calls primary review)' })
  async reviewCampaign(
    @Param('id',new ParseUUIDPipe()) campaignId: string,
    @Body() dto: ReviewDecisionDto,
    @Req() req: any,
  ) {
    const reviewerId = req.user.sub;
    const result = await this.moderationService.reviewCampaign(campaignId, {
      ...dto,
      decision: dto.decision,
      reasonCode: dto.reasonCode,
      note: dto.note,
      reviewerId,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin')
  @Post('promoters/:id/suspend')
  @ApiOperation({ summary: 'Suspend or unsuspend promoter account' })
  async suspendPromoter(
    @Param('id',new ParseUUIDPipe()) promoterId: string,
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

documentAdsController(ModerationController);
