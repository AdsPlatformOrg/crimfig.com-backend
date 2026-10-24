import { Controller, Get, Post, Put, Body, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdstationService } from './adstation.service';
import { PromotersService } from '../promoters/promoters.service';
import { IsString, IsIn, IsOptional, IsNumber } from 'class-validator';

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
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const slots = await this.adstationService.getSlots(promoter.id, websiteId);
    return { status: 'success', data: slots };
  }

  @Post('slots')
  @ApiOperation({ summary: 'Create an AdStation slot (consideration or direct)' })
  async createSlot(@Req() req: any, @Body() dto: CreateSlotDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const slot = await this.adstationService.createSlot(promoter.id, dto);
    return { status: 'success', data: slot };
  }

  @Post('websites/:websiteId/slots/:slotId/verify-consideration')
  @ApiOperation({ summary: 'Verify consideration slot status' })
  async verifyConsideration(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Param('slotId') slotId: string,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const result = await this.adstationService.verifyConsiderationSlot(promoter.id, websiteId, slotId);
    return { status: 'success', data: result };
  }

  @Put('websites/:websiteId/delivery-preference')
  @ApiOperation({ summary: 'Set website delivery preference (high, medium, low)' })
  async setDeliveryPreference(
    @Req() req: any,
    @Param('websiteId') websiteId: string,
    @Body() dto: UpdateDeliveryPreferenceDto,
  ) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const result = await this.adstationService.updateDeliveryPreference(promoter.id, websiteId, dto.preference);
    return { status: 'success', data: result };
  }

  @Get('websites/:websiteId/direct-campaigns')
  @ApiOperation({ summary: 'List direct campaigns for website' })
  async getDirectCampaigns(@Req() req: any, @Param('websiteId') websiteId: string) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const campaigns = await this.adstationService.getDirectCampaigns(promoter.id, websiteId);
    return { status: 'success', data: campaigns };
  }

  @Post('direct-campaigns')
  @ApiOperation({ summary: 'Create direct deal campaign (100% revenue to publisher)' })
  async createDirectCampaign(@Req() req: any, @Body() dto: CreateDirectDealDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId, 'WEBSITE');
    const campaign = await this.adstationService.createDirectCampaign(promoter.id, dto);
    return { status: 'success', data: campaign };
  }

  @Post('direct-events')
  @ApiOperation({ summary: 'Record direct deal impression/click event with idempotency' })
  async recordDirectEvent(
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
    const result = await this.adstationService.recordDirectEvent(dto);
    return { status: 'success', data: result };
  }

  @Get('websites/:websiteId/health')
  @ApiOperation({ summary: 'Audit consideration slot health and 48h grace status' })
  async getWebsiteHealth(@Param('websiteId') websiteId: string) {
    const result = await this.adstationService.checkConsiderationSlotHealth(websiteId);
    return { status: 'success', data: result };
  }

  @Post('admin/websites/:websiteId/suspend')
  @ApiOperation({ summary: 'Super Admin: Suspend website direct deal serving' })
  async suspendWebsite(
    @Param('websiteId') websiteId: string,
    @Body() dto: { reason: string },
  ) {
    const result = await this.adstationService.updateWebsiteAdstationStatus(websiteId, true, dto.reason);
    return { status: 'success', data: result };
  }

  @Post('admin/websites/:websiteId/reinstate')
  @ApiOperation({ summary: 'Super Admin: Reinstate website direct deal serving' })
  async reinstateWebsite(@Param('websiteId') websiteId: string) {
    const result = await this.adstationService.updateWebsiteAdstationStatus(websiteId, false);
    return { status: 'success', data: result };
  }
}

