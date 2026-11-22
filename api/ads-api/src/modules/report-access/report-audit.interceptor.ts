import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { catchError, from, mergeMap, throwError } from 'rxjs';
import { ReportAuditService, reportAction } from './report-audit.service';

@Injectable()
export class ReportAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: ReportAuditService) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest();
    if (!reportAction(request.path ?? '')) return next.handle();
    const reason = ['account_support', 'payment_investigation', 'policy_review'].includes(request.body?.reason)
      ? request.body.reason : undefined;
    return next.handle().pipe(
      catchError(error => from(this.audit.record(request, 'failed', 'REQUEST_FAILED')).pipe(
        mergeMap(() => throwError(() => error)),
      )),
      mergeMap(response => this.audit.record(request, 'allowed', reason).then(() => response)),
    );
  }
}
