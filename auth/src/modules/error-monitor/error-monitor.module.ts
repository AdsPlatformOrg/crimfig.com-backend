import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_GUARD, Reflector } from '@nestjs/core';
import { ErrorMonitorCaptureInterceptor, ErrorMonitorMetadataGuard } from '@crimfig/shared';
import { AuthModule } from '../auth/auth.module';
import { AuthStaffRoleGuard } from '../../security/auth-staff-role.guard';
import { ErrorMonitorService } from './error-monitor.service';
import {ErrorMonitorWorker} from './error-monitor.worker';
import {
  ErrorMonitorAdminController,
  ErrorMonitorIngestionController,
} from './error-monitor.controller';

@Module({
  imports: [AuthModule],
  controllers: [ErrorMonitorAdminController, ErrorMonitorIngestionController],
  providers: [
    ErrorMonitorService,
    {provide:APP_GUARD,useClass:ErrorMonitorMetadataGuard},
    ErrorMonitorWorker,
    AuthStaffRoleGuard,
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector, errorMonitorService: ErrorMonitorService) =>
        new ErrorMonitorCaptureInterceptor('auth-api', reflector, errorMonitorService),
      inject: [Reflector, ErrorMonitorService],
    },
  ],
  exports: [ErrorMonitorService],
})
export class ErrorMonitorModule {}

