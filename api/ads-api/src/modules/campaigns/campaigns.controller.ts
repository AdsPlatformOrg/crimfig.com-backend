import { Controller, Get, Post, Put, Body, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CampaignsService } from './campaigns.service';
import { IsString, IsNumber, IsOptional, Min, IsIn } from 'class-validator';
import { Public } from '@crimfig/shared';

export class CreateCampaignDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(5)
  budgetUsd: number;

  @IsOptional()
  @IsNumber()
  costPerImpressionCents?: number;

  @IsOptional()
  @IsNumber()
  costPerClickCents?: number;

  @IsOptional()
  @IsIn(['banner', 'card', 'video', 'interstitial'])
  format?: 'banner' | 'card' | 'video' | 'interstitial';
}

export class AddCreativeDto {
  @IsString()
  headline: string;

  @IsOptional()
  @IsString()
  bodyText?: string;

  @IsOptional()
  @IsString()
  ctaText?: string;

  @IsString()
  destinationUrl: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;
}

@ApiTags('Campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Public()
  @Get('catalog')
  @ApiOperation({ summary: 'Browse active campaigns available for promoters to display' })
  async getCatalog() {
    const catalog = await this.campaignsService.getPublicCatalog();
    return { status: 'success', data: catalog };
  }

  @Get()
  @ApiOperation({ summary: 'List advertiser campaigns' })
  async getAdvertiserCampaigns(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const campaigns = await this.campaignsService.getAdvertiserCampaigns(userId);
    return { status: 'success', data: campaigns };
  }

  @Post()
  @ApiOperation({ summary: 'Create new ad campaign' })
  async createCampaign(@Req() req: any, @Body() dto: CreateCampaignDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const campaign = await this.campaignsService.createCampaign({
      advertiserId: userId,
      title: dto.title,
      description: dto.description,
      budgetUsd: dto.budgetUsd,
      costPerImpressionCents: dto.costPerImpressionCents,
      costPerClickCents: dto.costPerClickCents,
      format: dto.format,
    });
    return { status: 'success', data: campaign };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get campaign details with creatives' })
  async getCampaignDetails(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'];
    const details = await this.campaignsService.getCampaignDetails(id, userId);
    return { status: 'success', data: details };
  }

  @Post(':id/creatives')
  @ApiOperation({ summary: 'Add creative asset to campaign' })
  async addCreative(@Param('id') campaignId: string, @Req() req: any, @Body() dto: AddCreativeDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const creative = await this.campaignsService.addCreative({
      campaignId,
      advertiserId: userId,
      headline: dto.headline,
      bodyText: dto.bodyText,
      ctaText: dto.ctaText,
      destinationUrl: dto.destinationUrl,
      imageUrl: dto.imageUrl,
      videoUrl: dto.videoUrl,
    });
    return { status: 'success', data: creative };
  }

  @Put(':id/status')
  @ApiOperation({ summary: 'Update campaign status' })
  async updateStatus(
    @Param('id') id: string,
    @Req() req: any,
    @Body('status') status: 'active' | 'paused' | 'cancelled',
  ) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const updated = await this.campaignsService.updateStatus(id, userId, status);
    return { status: 'success', data: updated };
  }
}
