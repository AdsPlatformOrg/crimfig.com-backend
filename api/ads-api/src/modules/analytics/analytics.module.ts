import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PromotersModule } from '../promoters/promoters.module';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [PromotersModule],
  controllers: [AnalyticsController, ReportsController],
  providers: [AnalyticsService, ReportsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
