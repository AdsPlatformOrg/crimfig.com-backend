import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdsRoles } from '../security/ads-staff-grants';
import { AdminPlatformMetricsService } from './admin-platform-metrics.service';

@ApiTags('Admin Platform Metrics')
@ApiBearerAuth()
@Controller('admin/platform-metrics')
export class AdminPlatformMetricsController {
  constructor(private readonly metrics: AdminPlatformMetricsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles(
    'super_admin',
    'ads_admin',
    'ads_finance',
    'ads_support',
    'report_auditor',
    'ads_reviewer',
    'ads_manager',
    'report_contact_reveal',
  )
  @ApiOperation({
    summary: 'Get platform-wide user signup, website verification, ad-slot installation, and campaign overview metrics',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Time window in days (7, 14, 30, or 90)' })
  async overview(@Query('days') days?: string) {
    return {
      status: 'success',
      data: await this.metrics.getOverview(days),
    };
  }
}
