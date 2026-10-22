import { AdsRoles } from '../security/ads-staff-grants';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { IsString, IsOptional, IsIn, IsNumber } from 'class-validator';

export class CreateDisputeDto {
  @IsIn(['advertiser', 'promoter'])
  role: 'advertiser' | 'promoter';

  @IsIn(['campaign', 'placement', 'general'])
  scope: 'campaign' | 'placement' | 'general';

  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsOptional()
  @IsString()
  placementId?: string;

  @IsString()
  periodFrom: string;

  @IsString()
  periodTo: string;

  @IsString()
  reason: string;

  @IsString()
  details: string;
}

export class ResolveDisputeDto {
  @IsString()
  outcome: string;

  @IsIn(['resolved_adjusted', 'resolved_upheld', 'rejected'])
  status: 'resolved_adjusted' | 'resolved_upheld' | 'rejected';

  @IsOptional()
  @IsNumber()
  adjustmentMicros?: number;
}

@ApiTags('Ads Disputes & Traffic Quality Appeals')
@Controller()
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  /**
   * File a dispute or quality appeal
   * POST /api/v1/disputes
   */
  @Post('disputes')
  @ApiOperation({ summary: 'Open invalid traffic dispute or appeal' })
  async createDispute(@Req() req: any, @Body() dto: CreateDisputeDto) {
    const userId = req.user.sub;
    const dispute = await this.disputesService.createDispute({
      openedBy: userId,
      role: dto.role,
      scope: dto.scope,
      campaignId: dto.campaignId,
      placementId: dto.placementId,
      periodFrom: dto.periodFrom,
      periodTo: dto.periodTo,
      reason: dto.reason,
      details: dto.details,
    });

    return { status: 'success', data: dispute };
  }

  /**
   * List disputes for authenticated user / role
   * GET /api/v1/disputes
   */
  @Get('disputes')
  @ApiOperation({ summary: 'List disputes' })
  async getDisputes(
    @Req() req: any,
    @Query('role') role?: 'advertiser' | 'promoter',
    @Query('status') status?: string,
    @Query('limit') limit = '50',
  ) {
    const userId = req.user.sub;
    const data = await this.disputesService.getDisputes({
      openedBy: userId,
      role,
      status,
      limit: Number(limit),
    });

    return { status: 'success', data };
  }

  /**
   * Get single dispute dossier
   * GET /api/v1/disputes/:id
   */
  @Get('disputes/:id')
  @ApiOperation({ summary: 'Get dispute details' })
  async getDisputeById(@Param('id') id: string, @Req() req: any) {
    const data = await this.disputesService.getDisputeById(id, req.user.sub);
    return { status: 'success', data };
  }

  /**
   * Admin resolution of dispute
   * POST /api/v1/admin/ads/disputes/:id/resolve
   */
  @AdsRoles('ads_finance', 'ads_admin', 'super_admin')
  @Post('admin/ads/disputes/:id/resolve')
  @ApiOperation({ summary: 'Resolve dispute with findings and ledger adjustment' })
  async resolveDispute(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: ResolveDisputeDto,
  ) {
    const adminId = req.user.sub;
    const data = await this.disputesService.resolveDispute(id, {
      outcome: dto.outcome,
      status: dto.status,
      adjustmentMicros: dto.adjustmentMicros,
      adminId,
    });

    return { status: 'success', data };
  }
}
