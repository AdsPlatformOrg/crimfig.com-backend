import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response, Request } from 'express';

@Catch()
export class AdsGlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('AdsGlobalException');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : (exception instanceof Error ? exception.message : 'Internal Server Error');

    const errorDetails = typeof message === 'object' && message !== null
      ? message
      : { message };

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - Status ${status} - Error: ${exception instanceof Error ? exception.stack || exception.message : String(exception)}`,
      );
    } else if (status === 403 || status === 401) {
      this.logger.warn(
        `[${request.method}] ${request.url} - Status ${status} - Auth check failed for user: ${(request as any)?.user?.sub || 'anonymous'}`,
      );
    }

    response.status(status).json({
      status: 'error',
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...errorDetails,
    });
  }
}
