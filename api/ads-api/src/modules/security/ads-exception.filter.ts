import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response, Request } from 'express';
import { safeApiError } from '../../contracts/api-error';

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

    const errorDetails = safeApiError(status, message, request.route?.path, request.headers['x-request-id']);

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${errorDetails.path} - Status ${status} - ${errorDetails.code} - request ${errorDetails.requestId}`,
      );
    } else if (status === 403 || status === 401) {
      this.logger.warn(
        `[${request.method}] ${errorDetails.path} - Status ${status} - request ${errorDetails.requestId}`,
      );
    }

    response.setHeader('X-Request-Id', errorDetails.requestId);
    response.status(status).json(errorDetails);
  }
}
