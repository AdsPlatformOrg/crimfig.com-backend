import { Controller, Get, Put, Body, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { PromotersService } from '../promoters/promoters.service';

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly promotersService: PromotersService,
  ) {}

  @Get('dashboard/summary')
  @ApiOperation({ summary: 'Get advertiser dashboard summary metrics with period filter' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d', 'custom'] })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getDashboardSummary(
    @Req() req: any,
    @Query('period') period?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const userId = req.user.sub;
    const summary = await this.analyticsService.getDashboardSummary(userId, period, startDate, endDate);
    return { status: 'success', data: summary };
  }

  @Get('dashboard/timeseries')
  @ApiOperation({ summary: 'Get advertiser dashboard timeseries chart data' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d', 'custom'] })
  async getDashboardTimeseries(@Req() req: any, @Query('period') period?: string) {
    const userId = req.user.sub;
    const timeseries = await this.analyticsService.getDashboardTimeseries(userId, period);
    return { status: 'success', data: timeseries };
  }

  @Get('dashboard/channel-breakdown')
  @ApiOperation({ summary: 'Get advertiser channel performance breakdown' })
  @ApiQuery({ name: 'period', required: false, enum: ['7d', '30d', '90d'] })
  async getDashboardChannelBreakdown(@Req() req: any, @Query('period') period?: string) {
    const userId = req.user.sub;
    const breakdown = await this.analyticsService.getDashboardChannelBreakdown(userId, period);
    return { status: 'success', data: breakdown };
  }

  @Get('dashboard/alerts')
  @ApiOperation({ summary: 'Get actionable alerts for advertiser dashboard' })
  async getDashboardAlerts(@Req() req: any) {
    const userId = req.user.sub;
    const alerts = await this.analyticsService.getDashboardAlerts(userId);
    return { status: 'success', data: alerts };
  }

  @Get('table-preferences')
  @ApiOperation({ summary: 'Get customized table column preferences' })
  @ApiQuery({ name: 'tableName', required: false })
  async getTablePreferences(@Req() req: any, @Query('tableName') tableName?: string) {
    const userId = req.user.sub;
    const prefs = await this.analyticsService.getUserTablePreferences(userId, tableName);
    return { status: 'success', data: prefs };
  }

  @Put('table-preferences')
  @ApiOperation({ summary: 'Save customized table column preferences' })
  async saveTablePreferences(
    @Req() req: any,
    @Body('tableName') tableName: string,
    @Body('columnsConfig') columnsConfig: any,
  ) {
    const userId = req.user.sub;
    const saved = await this.analyticsService.saveUserTablePreferences(userId, tableName, columnsConfig);
    return { status: 'success', data: saved };
  }

  @Get('promoter')
  @ApiOperation({ summary: 'Get promoter impressions, clicks, CTR, and earnings' })
  async getPromoterAnalytics(@Req() req: any) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId);
    const stats = await this.analyticsService.getPromoterAnalytics(promoter.id);
    return { status: 'success', data: stats };
  }

  @Get('advertiser')
  @ApiOperation({ summary: 'Get advertiser campaigns, budget spend, and conversion metrics' })
  async getAdvertiserAnalytics(@Req() req: any) {
    const userId = req.user.sub;
    const stats = await this.analyticsService.getAdvertiserAnalytics(userId);
    return { status: 'success', data: stats };
  }
}
