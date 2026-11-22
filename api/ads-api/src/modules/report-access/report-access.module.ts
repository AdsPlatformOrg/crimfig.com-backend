import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AdsStaffGrants } from '../security/ads-staff-grants';
import { ReportAuditService } from './report-audit.service';
import { ReportAuditInterceptor } from './report-audit.interceptor';
import { AdminReportsController } from './reports.controller';

@Global()
@Module({
  imports: [DatabaseModule], controllers: [AdminReportsController],
  providers: [AdsStaffGrants, ReportAuditService, ReportAuditInterceptor],
  exports: [AdsStaffGrants, ReportAuditService, ReportAuditInterceptor],
})
export class ReportAccessModule {}
