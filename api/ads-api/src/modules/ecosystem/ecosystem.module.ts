import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { AdsStaffGrants } from '../security/ads-staff-grants';
import { AdminPlatformMetricsController } from './admin-platform-metrics.controller';
import { AdminPlatformMetricsService } from './admin-platform-metrics.service';

@Module({
  controllers: [EcosystemController, AdminPlatformMetricsController],
  providers: [AdsStaffGrants, AdminPlatformMetricsService],
})
export class EcosystemModule { }
