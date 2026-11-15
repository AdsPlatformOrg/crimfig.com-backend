import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdsRoles } from '../security/ads-staff-grants';
import { AdsCronSchedulerService } from './ads-cron-scheduler.service';

@ApiTags('Ads Scheduling Health')
@Controller()
export class SchedulingMonitorController {
  constructor(private readonly scheduler: AdsCronSchedulerService) {}

  @AdsRoles('ads_admin', 'super_admin')
  @Get(['admin/ads/scheduling/health', 'adstation/admin/scheduling/health'])
  @ApiOperation({
    summary:
      'Admin: Read-only health snapshot of registered in-process cron jobs, distributed leases, backlog, and recent runs (PLAN-0114)',
  })
  async getSchedulingHealth() {
    const snapshot = await this.scheduler.getHealthSnapshot();
    return {
      status: 'success',
      data: snapshot,
    };
  }
}

