import { AdsRoles } from '../security/ads-staff-grants';
import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdstationService, UpdateAdstationSlotDto } from './adstation.service';
import { PromotersService } from '../promoters/promoters.service';
import {
  IsString,
  IsIn,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsArray,
} from 'class-validator';

export class CreateSlotDto {
  @IsString()
  websiteId: string;

  @IsString()
  name: string;

  @IsIn(['consideration', 'direct', 'network', 'hybrid'])
  slotType: 'consideration' | 'direct' | 'network' | 'hybrid';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  slotDeliveryPreference?: string;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;

  @IsOptional()
  @IsBoolean()
  responsive?: boolean;

  @IsOptional()
  @IsArray()
  allowedAdTypes?: string[];
}

export class UpdateDeliveryPreferenceDto {
  @IsIn(['high', 'medium', 'low'])
  preference: 'high' | 'medium' | 'low';
}

export class CreateDirectDealDto {
  @IsString()
  websiteId: string;

  @IsOptional()
  @IsString()
  slotId?: string;

  @IsString()
  clientName: string;

  @IsString()
  campaignTitle: string;

  @IsString()
  destinationUrl: string;

  @IsOptional()
  @IsString()
  headline?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsNumber()
  targetImpressions?: number;
}

@ApiTags('AdStation')
@Controller('adstation')
export class AdstationController {
  constructor(
    private readonly adstationService: AdstationService,
    private readonly promotersService: PromotersService,
  ) {}

  @Get('websites/:websiteId/slots')
  @ApiOperation({ summary: 'List AdStation slots for website' })
  async getSlots(@Req() req: any, @Param('websiteId') websiteId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slots = await this.adstationService.getSlots(promoter.id, websiteId);
    return { status: 'success', data: slots };
  }

  @Post('slots')
  @ApiOperation({
    summary: 'Create a canonical AdStation slot (consideration, network, hybrid, or direct)',
  })
  async createSlot(@Req() req: any, @Body() dto: CreateSlotDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slot = await this.adstationService.createSlot(promoter.id, dto);
    return { status: 'success', data: slot };
  }

  @Patch('slots/:slotId')
  @ApiOperation({ summary: 'Update AdStation slot lifecycle or configuration' })
  async updateSlot(
    @Req() req: any,
    @Param('slotId') slotId: string,
    @Body() dto: UpdateAdstationSlotDto,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const slot = await this.adstationService.updateSlot(
      promoter.id,
      slotId,
      dto,
    );
    return { status: 'success', data: slot };
  }

  @Get('slots/:slotId/embed')
  @ApiOperation({
    summary: 'Get environment-safe HTML and Next.js embed snippet for a slot',
  })
  async getSlotEmbed(@Req() req: any, @Param('slotId') slotId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const embed = await this.adstationService.getSlotEmbedInstructions(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: embed };
  }

  @Post('slots/:slotId/check-installation')
  @ApiOperation({
    summary: 'Run evidence-driven installation check for a canonical slot',
  })
  async checkSlotInstallation(
    @Req() req: any,
    @Param('slotId') slotId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.adstationService.checkSlotInstallation(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: result };
  }

  @Get('slots/:slotId/diagnostics')
  @ApiOperation({
    summary: 'Get safe promoter-facing telemetry and diagnostics for a slot',
  })
  async getSlotDiagnostics(@Req() req: any, @Param('slotId') slotId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const diagnostics = await this.adstationService.getSlotDiagnostics(
      promoter.id,
      slotId,
    );
    return { status: 'success', data: diagnostics };
  }

  @Post('websites/:websiteId/slots/:slotId/verify-consideration')
  @ApiOperation({ summary: 'Verify consideration slot status' })
  async verifyConsideration(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Param('slotId') slotId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.adstationService.verifyConsiderationSlot(
      promoter.id,
      websiteId,
      slotId,
    );
    return { status: 'success', data: result };
  }

  @Put('websites/:websiteId/delivery-preference')
  @ApiOperation({
    summary: 'Set website delivery preference (high, medium, low)',
  })
  async setDeliveryPreference(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Body() dto: UpdateDeliveryPreferenceDto,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.adstationService.updateDeliveryPreference(
      promoter.id,
      websiteId,
      dto.preference,
    );
    return { status: 'success', data: result };
  }

  @Get('direct-campaigns')
  @ApiOperation({ summary: 'List direct campaigns across promoter websites' })
  async getAllDirectCampaigns(@Req() req: any) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const campaigns = await this.adstationService.getDirectCampaigns(
      promoter.id,
      '',
    );
    return { status: 'success', data: campaigns };
  }

  @Get('websites/:websiteId/direct-campaigns')
  @ApiOperation({ summary: 'List direct campaigns for website' })
  async getDirectCampaigns(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const campaigns = await this.adstationService.getDirectCampaigns(
      promoter.id,
      websiteId,
    );
    return { status: 'success', data: campaigns };
  }

  @Post('direct-campaigns')
  @ApiOperation({
    summary: 'Create direct deal campaign (100% revenue to publisher)',
  })
  async createDirectCampaign(@Req() req: any, @Body() dto: CreateDirectDealDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const campaign = await this.adstationService.createDirectCampaign(
      promoter.id,
      dto,
    );
    return { status: 'success', data: campaign };
  }

  @Post('direct-events')
  @ApiOperation({
    summary: 'Record direct deal impression/click event with idempotency',
  })
  async recordDirectEvent(
    @Req() req: any,
    @Body()
    dto: {
      directCampaignId: string;
      websiteId: string;
      slotId?: string;
      eventType: 'impression' | 'viewable_impression' | 'click' | 'hover';
      idempotencyKey: string;
      isViewable?: boolean;
      viewDurationMs?: number;
    },
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.adstationService.recordDirectEvent({
      ...dto,
      promoterId: promoter.id,
    });
    return { status: 'success', data: result };
  }

  @Get('websites/:websiteId/health')
  @ApiOperation({
    summary: 'Audit consideration slot health and 48h grace status',
  })
  async getWebsiteHealth(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(
      userId,
      'WEBSITE',
    );
    const result = await this.adstationService.checkConsiderationSlotHealth(
      websiteId,
      promoter.id,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin')
  @Post('admin/websites/:websiteId/suspend')
  @ApiOperation({ summary: 'Super Admin: Suspend website direct deal serving' })
  async suspendWebsite(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Body() dto: { reason: string },
  ) {
    const result = await this.adstationService.updateWebsiteAdstationStatus(
      websiteId,
      true,
      dto.reason,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin')
  @Post('admin/websites/:websiteId/reinstate')
  @ApiOperation({
    summary: 'Super Admin: Reinstate website direct deal serving',
  })
  async reinstateWebsite(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
  ) {
    const result = await this.adstationService.updateWebsiteAdstationStatus(
      websiteId,
      false,
      undefined,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Post('admin/websites/:websiteId/policy')
  @ApiOperation({
    summary: 'Admin: Approve, reject, or set testing policy status on a promoter website',
  })
  async reviewWebsitePolicy(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Body()
    dto: {
      decision: 'approved' | 'rejected' | 'testing' | 'suspended';
      reason?: string;
    },
  ) {
    const result = await this.adstationService.reviewWebsitePolicy(
      websiteId,
      dto.decision,
      dto.reason,
      req.user?.sub,
    );
    return { status: 'success', data: result };
  }

  @AdsRoles('ads_admin', 'super_admin', 'ads_reviewer')
  @Get('admin/auction-decisions')
  @ApiOperation({
    summary: 'Admin: List recent tamper-evident auction decision snapshots',
  })
  async listAuctionDecisions(
    @Query('limit') limit?: number,
    @Query('slotTagId') slotTagId?: string,
  ) {
    const decisions = await this.adstationService.listAuctionDecisions(
      limit,
      slotTagId,
    );
    return { status: 'success', data: decisions };
  }
}
