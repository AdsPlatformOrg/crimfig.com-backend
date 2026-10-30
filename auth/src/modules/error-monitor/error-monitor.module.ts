import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ErrorMonitorCaptureInterceptor } from '@crimfig/shared';
import { AuthModule } from '../auth/auth.module';
import { AuthStaffRoleGuard } from '../../security/auth-staff-role.guard';
import { ErrorMonitorService } from './error-monitor.service';
import {
  ErrorMonitorAdminController,
  ErrorMonitorIngestionController,
} from './error-monitor.controller';

@Module({
  imports: [AuthModule],
  controllers: [ErrorMonitorAdminController, ErrorMonitorIngestionController],
  providers: [
    ErrorMonitorService,
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

