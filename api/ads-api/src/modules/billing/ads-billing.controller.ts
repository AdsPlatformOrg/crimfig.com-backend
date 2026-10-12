import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdsEscrowService } from './ads-escrow.service';
import { AdsSettlementService } from './ads-settlement.service';
import { IsString, IsNumber, Min, IsOptional } from 'class-validator';

export class LockCampaignEscrowDto {
  @IsString()
  campaignId: string;

  @IsNumber()
  @Min(500) // Minimum $5.00 (500 cents)
  amountUsdCents: number;

  @IsOptional()
  @IsString()
  campaignTitle?: string;
}

export class ReleaseCampaignEscrowDto {
  @IsString()
  campaignId: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Ads Billing & Escrow')
@Controller('api/v1/ads/billing')
export class AdsBillingController {
  constructor(
    private readonly escrowService: AdsEscrowService,
    private readonly settlementService: AdsSettlementService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get unified advertiser balance and escrow status' })
  async getOverview(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const data = await this.escrowService.getBillingOverview(userId);
    return { status: 'success', data };
  }

  @Post('escrow/lock')
  @ApiOperation({ summary: 'Lock campaign budget into escrow' })
  async lockEscrow(@Req() req: any, @Body() dto: LockCampaignEscrowDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const escrow = await this.escrowService.lockCampaignBudget({
      campaignId: dto.campaignId,
      userId,
      amountUsdCents: dto.amountUsdCents,
      campaignTitle: dto.campaignTitle,
    });
    return { status: 'success', data: escrow };
  }

  @Post('escrow/release')
  @ApiOperation({ summary: 'Release unconsumed escrow budget upon campaign pause/trash' })
  async releaseEscrow(@Req() req: any, @Body() dto: ReleaseCampaignEscrowDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.escrowService.releaseCampaignBudget({
      campaignId: dto.campaignId,
      userId,
      reason: dto.reason,
    });
    return { status: 'success', data: result };
  }

  @Get('escrow/:campaignId')
  @ApiOperation({ summary: 'Get escrow details for a campaign' })
  async getCampaignEscrow(@Param('campaignId') campaignId: string) {
    const escrow = await this.escrowService.getCampaignEscrow(campaignId);
    return { status: 'success', data: escrow };
  }

  @Get('settlements')
  @ApiOperation({ summary: 'List historical settlement batches' })
  async getSettlements(@Query('page') page = '1', @Query('limit') limit = '20') {
    const data = await this.settlementService.getHistoricalBatches(Number(page), Number(limit));
    return { status: 'success', data };
  }

  @Get('settlements/:batchId')
  @ApiOperation({ summary: 'Get settlement batch details and item lines' })
  async getSettlementDetails(@Param('batchId') batchId: string) {
    const data = await this.settlementService.getSettlementBatchDetails(batchId);
    return { status: 'success', data };
  }

  @Post('settlements/trigger')
  @ApiOperation({ summary: 'Manually trigger settlement batch reconciliation' })
  async triggerSettlement() {
    const batch = await this.settlementService.processPendingSettlement();
    return { status: 'success', message: 'Batch reconciliation completed', data: batch };
  }
}
