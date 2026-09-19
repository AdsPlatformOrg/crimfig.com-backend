import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { PromotersService } from '../promoters/promoters.service';

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly promotersService: PromotersService,
  ) {}

  @Get('promoter')
  @ApiOperation({ summary: 'Get promoter impressions, clicks, CTR, and earnings' })
  async getPromoterAnalytics(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const promoter = await this.promotersService.getOrCreatePromoter(userId);
    const stats = await this.analyticsService.getPromoterAnalytics(promoter.id);
    return { status: 'success', data: stats };
  }

  @Get('advertiser')
  @ApiOperation({ summary: 'Get advertiser campaigns, budget spend, and conversion metrics' })
  async getAdvertiserAnalytics(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const stats = await this.analyticsService.getAdvertiserAnalytics(userId);
    return { status: 'success', data: stats };
  }
}
