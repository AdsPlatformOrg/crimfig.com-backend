import { AdsRoles } from '../security/ads-staff-grants';
import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdsEscrowService } from './ads-escrow.service';
import { AdsSettlementService } from './ads-settlement.service';
import { DeferredAuditService } from './deferred-audit.service';
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
@AdsRoles('ads_finance', 'ads_admin', 'super_admin')
@Controller('ads/billing')
export class AdsBillingController {
  constructor(
    private readonly escrowService: AdsEscrowService,
    private readonly settlementService: AdsSettlementService,
    private readonly auditService: DeferredAuditService,
  ) {}

  @AdsRoles()
  @Get('overview')
  @ApiOperation({ summary: 'Get unified advertiser balance and escrow status' })
  async getOverview(@Req() req: any) {
    const userId = req.user.sub;
    const data = await this.escrowService.getBillingOverview(userId);
    return { status: 'success', data };
  }

  @AdsRoles()
  @Post('escrow/lock')
  @ApiOperation({ summary: 'Lock campaign budget into escrow' })
  async lockEscrow(@Req() req: any, @Body() dto: LockCampaignEscrowDto) {
    const userId = req.user.sub;
    const escrow = await this.escrowService.lockCampaignBudget({
      campaignId: dto.campaignId,
      userId,
      amountUsdCents: dto.amountUsdCents,
      campaignTitle: dto.campaignTitle,
    });
    return { status: 'success', data: escrow };
  }

  @AdsRoles()
  @Post('escrow/release')
  @ApiOperation({ summary: 'Release unconsumed escrow budget upon campaign pause/trash' })
  async releaseEscrow(@Req() req: any, @Body() dto: ReleaseCampaignEscrowDto) {
    const userId = req.user.sub;
    const result = await this.escrowService.releaseCampaignBudget({
      campaignId: dto.campaignId,
      userId,
      reason: dto.reason,
    });
    return { status: 'success', data: result };
  }

  @AdsRoles()
  @Get('escrow/:campaignId')
  @ApiOperation({ summary: 'Get escrow details for a campaign' })
  async getCampaignEscrow(@Param('campaignId') campaignId: string, @Req() req: any) {
    const escrow = await this.escrowService.getCampaignEscrow(campaignId, req.user.sub);
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

  @Get('audits')
  @ApiOperation({ summary: 'List multi-tier deep audit runs (Tier 2 6h, Tier 3 15d/30d)' })
  async getAuditRuns(@Query('limit') limit = '20') {
    const data = await this.auditService.getAuditRuns(Number(limit));
    return { status: 'success', data };
  }

  @Get('rebates')
  @ApiOperation({ summary: 'List advertiser rebates issued by deep fraud audits' })
  async getRebates(@Query('campaignId') campaignId?: string) {
    const data = await this.auditService.getRebates(campaignId);
    return { status: 'success', data };
  }

  @Get('penalties')
  @ApiOperation({ summary: 'List promoter retrospective fraud penalties' })
  async getPenalties(@Query('promoterId') promoterId?: string) {
    const data = await this.auditService.getPromoterPenalties(promoterId);
    return { status: 'success', data };
  }

  @Post('audits/trigger-6h')
  @ApiOperation({ summary: 'Trigger Tier-2 6-hour deep macro audit (72h rolling lookback)' })
  async trigger6HourAudit() {
    const run = await this.auditService.runTier2DeepMacroAudit({ lookbackHours: 72 });
    return { status: 'success', message: 'Tier-2 72h Deep Audit Completed', data: run };
  }

  @Post('audits/trigger-clearance')
  @ApiOperation({ summary: 'Trigger 72-hour clearance graduation for pending promoter earnings' })
  async triggerClearanceGraduation() {
    const result = await this.auditService.graduateClearedEarnings();
    return { status: 'success', message: '72-Hour Clearance Graduation Completed', data: result };
  }

  @Post('audits/trigger-extended')
  @ApiOperation({ summary: 'Trigger Tier-3 extended audit (15d or 30d)' })
  async triggerExtendedAudit(@Query('level') level: 'tier3_15d' | 'tier3_30d' = 'tier3_15d') {
    const run = await this.auditService.runTier3ExtendedAudit(level);
    return { status: 'success', message: `Tier-3 ${level} Audit Completed`, data: run };
  }
}
