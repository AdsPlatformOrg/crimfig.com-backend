import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError, throwError } from 'rxjs';
import {
  FINANCIAL_OPERATION_KEY,
  type FinancialOperationMetadata,
  ensureRequestId,
  redactAndSanitizeErrorEvent,
  type RawErrorCaptureInput,
  type SanitizedErrorMonitorEvent,
} from './error-monitor.contract';
import { resolveErrorMonitorConfig } from './error-alert.config';
import { CrimfigLogger } from '../logger';

export interface ErrorMonitorSink {
  recordEvent(event: SanitizedErrorMonitorEvent): Promise<unknown>;
}

/**
 * Shared NestJS HTTP response & exception capture interceptor.
 * Guarantees at-most-once capture per HTTP request/response lifecycle (`__crimfigErrorCaptured` guard)
 * and skips recursive self-monitoring on `/admin/error-monitor` and `/internal/error-monitor` routes.
 */
@Injectable()
export class ErrorMonitorCaptureInterceptor implements NestInterceptor {
  private readonly logger: CrimfigLogger;

  constructor(
    private readonly serviceName: string,
    private readonly reflector: Reflector,
    private readonly sink?: ErrorMonitorSink,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.logger = new CrimfigLogger('ErrorMonitorCapture', serviceName);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const res = http.getResponse<any>();

    const requestId = ensureRequestId(req?.headers?.['x-request-id'] ?? req?.requestId);
    const correlationId = ensureRequestId(
      req?.headers?.['x-correlation-id'] ?? req?.headers?.['x-request-id'] ?? requestId,
    );

    if (req) {
      req.requestId = requestId;
      req.correlationId = correlationId;
    }
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-Request-Id', requestId);
      res.setHeader('X-Correlation-Id', correlationId);
    }

    const rawPath: string = req?.route?.path || req?.originalUrl || req?.url || '/<unresolved>';
    // Prevent recursive self-capture on error-monitor ingestion or admin polling endpoints
    if (/\/(?:admin|internal)\/error-monitor\b/i.test(rawPath)) {
      return next.handle();
    }

    const financialMeta = this.reflector.getAllAndOverride<FinancialOperationMetadata | undefined>(
      FINANCIAL_OPERATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    return next.handle().pipe(
      tap(() => {
        const statusCode = Number(res?.statusCode || 200);
        if (statusCode >= 400 && statusCode <= 599) {
          this.captureOnce(req, {
            service: this.serviceName,
            httpMethod: req?.method || 'GET',
            route: rawPath,
            statusCode,
            isFinancialRoute: Boolean(financialMeta?.isFinancial),
            financialCategory: financialMeta?.category ?? null,
            requestId,
            correlationId,
            actorUserId: req?.user?.sub ?? null,
          });
        }
      }),
      catchError((err: unknown) => {
        const statusCode =
          err instanceof HttpException
            ? err.getStatus()
            : typeof (err as any)?.status === 'number'
              ? (err as any).status
              : HttpStatus.INTERNAL_SERVER_ERROR;

        const responsePayload = err instanceof HttpException ? err.getResponse() : undefined;
        const code =
          responsePayload && typeof responsePayload === 'object' && 'code' in responsePayload
            ? String((responsePayload as any).code)
            : undefined;

        this.captureOnce(req, {
          service: this.serviceName,
          httpMethod: req?.method || 'GET',
          route: rawPath,
          statusCode,
          errorCategory: code,
          isFinancialRoute: Boolean(financialMeta?.isFinancial),
          financialCategory: financialMeta?.category ?? null,
          requestId,
          correlationId,
          actorUserId: req?.user?.sub ?? null,
          upstreamService: (err as any)?.upstreamService ?? null,
          upstreamStatusCode: (err as any)?.upstreamStatusCode ?? null,
        });

        return throwError(() => err);
      }),
    );
  }

  private captureOnce(req: any, rawInput: RawErrorCaptureInput): void {
    if (req && req.__crimfigErrorCaptured) {
      return;
    }
    if (req) {
      req.__crimfigErrorCaptured = true;
    }

    try {
      const runtimeConfig = resolveErrorMonitorConfig(this.env);
      if (!runtimeConfig.captureEnabled) {
        return;
      }

      const sanitized = redactAndSanitizeErrorEvent(
        {
          ...rawInput,
          environment: runtimeConfig.environment,
          deploymentId: this.env.RAILWAY_DEPLOYMENT_ID ?? null,
        },
        this.env,
      );

      if (this.sink) {
        void this.sink.recordEvent(sanitized).catch(() => {
          this.logger.warn('Failed to persist error monitor event', {
            requestId: sanitized.requestId,
            reason: 'MONITOR_SINK_FAILED',
          });
        });
      }
    } catch {
      this.logger.warn('Skipped error monitor capture due to configuration or sanitization error', {
        reason: 'MONITOR_CONFIGURATION_OR_SANITIZATION_FAILED',
      });
    }
  }
}
