import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdstationService } from './adstation.service';
import { PublisherInventoryController } from '../publisher-inventory/publisher-inventory.controller';
export { CreateSlotDto } from '../publisher-inventory/publisher-inventory.controller';
import { PromotersService } from '../promoters/promoters.service';
import { SetupChecksService } from './setup-checks.service';
import {
  IsString,
  IsIn,
  IsOptional,
  IsNumber,
} from 'class-validator';

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
export class AdstationController extends PublisherInventoryController {
  constructor(
    private readonly adstationService: AdstationService,
    promotersService: PromotersService,
    setupChecks: SetupChecksService,
  ) { super(adstationService, promotersService, setupChecks); }

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

}
