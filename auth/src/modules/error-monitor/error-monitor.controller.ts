import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  Req,
  UseGuards,
  UnauthorizedException,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsObject,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { AuthRoles } from '../../security/auth-staff-grants';
import { AuthStaffRoleGuard } from '../../security/auth-staff-role.guard';
import { ErrorMonitorService } from './error-monitor.service';

export class IngestInternalErrorEventDto {
  @IsString()
  @MaxLength(64)
  service!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  environment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  source?: 'server' | 'browser';

  @IsString()
  @MaxLength(16)
  httpMethod!: string;

  @IsString()
  @MaxLength(255)
  route!: string;

  @IsInt()
  @Min(400)
  @Max(599)
  statusCode!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  errorCategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  safeSummary?: string;

  @IsOptional()
  @IsBoolean()
  isFinancialRoute?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  financialCategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(96)
  deploymentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  upstreamService?: string;

  @IsOptional()
  @IsInt()
  upstreamStatusCode?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorUserId?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class ReportBrowserErrorDto {
  @IsString()
  @MaxLength(64)
  service!: string;

  @IsString()
  @MaxLength(255)
  route!: string;

  @IsOptional()
  @IsInt()
  @Min(400)
  @Max(599)
  statusCode?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  errorCategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  safeSummary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestId?: string;
}

@ApiTags('Platform Admin — Error Monitor')
@UseGuards(ThrottlerGuard, JwtAuthGuard, AuthStaffRoleGuard)
@AuthRoles('super_admin')
@ApiBearerAuth()
@Controller({ path: 'admin/error-monitor', version: '1' })
export class ErrorMonitorAdminController {
  constructor(private readonly errorMonitorService: ErrorMonitorService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Platform Admin (super_admin): Get platform error monitor summary and email policy health',
  })
  async getSummary(
    @Query('environment') environment?: string,
    @Query('service') service?: string,
    @Query('timeRange') timeRange?: '1h' | '24h' | '7d' | '30d' | 'all',
  ) {
    const data = await this.errorMonitorService.getSummary({
      environment,
      service,
      timeRange,
    });
    return { status: 'success', data };
  }

  @Get('errors')
  @ApiOperation({
    summary: 'Platform Admin (super_admin): List grouped sanitized platform errors and correlated chains',
  })
  async listErrors(
    @Query('environment') environment?: string,
    @Query('service') service?: string,
    @Query('source') source?: string,
    @Query('statusCode') statusCode?: string,
    @Query('statusClass') statusClass?: '4xx' | '5xx',
    @Query('route') route?: string,
    @Query('errorCategory') errorCategory?: string,
    @Query('requestId') requestId?: string,
    @Query('emailState') emailState?: string,
    @Query('timeRange') timeRange?: '1h' | '24h' | '7d' | '30d' | 'all',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedStatusCode =
      statusCode && /^\d{3}$/.test(statusCode.trim()) ? Number(statusCode.trim()) : undefined;

    const data = await this.errorMonitorService.listErrorGroups({
      environment,
      service,
      source,
      statusCode: parsedStatusCode,
      statusClass,
      route,
      errorCategory,
      requestId,
      emailState,
      timeRange,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return { status: 'success', data };
  }

  @Get('errors/:id')
  @ApiOperation({
    summary: 'Platform Admin (super_admin): Inspect a single error group, occurrence samples, and outbox history',
  })
  async getErrorDetail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const data = await this.errorMonitorService.getErrorGroupDetail(id);
    return { status: 'success', data };
  }

  @Get('sources')
  @ApiOperation({
    summary: 'Platform Admin (super_admin): List registered first-party apps/services and reporting coverage',
  })
  async getSources(@Query('environment') environment?: string) {
    const data = await this.errorMonitorService.listSources(environment);
    return { status: 'success', data };
  }

  @Post('outbox/dispatch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Platform Admin (super_admin): Process due outbox notifications using lease locking',
  })
  async dispatchDueOutbox() {
    const data = await this.errorMonitorService.processDueOutbox();
    return { status: 'success', data };
  }
}

@ApiTags('Internal Error Monitor Ingestion')
@UseGuards(ThrottlerGuard)
@Controller({ path: 'internal/error-monitor', version: '1' })
export class ErrorMonitorIngestionController {
  constructor(private readonly errorMonitorService: ErrorMonitorService) {}

  private verifyInternalKey(providedKey: string | undefined) {
    const expectedKey =
      process.env.ERROR_MONITOR_INTERNAL_KEY || process.env.INTERNAL_ECOSYSTEM_KEY || '';
    if (
      !expectedKey ||
      typeof providedKey !== 'string' ||
      !providedKey ||
      Buffer.byteLength(providedKey) !== Buffer.byteLength(expectedKey) ||
      !timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey))
    ) {
      throw new UnauthorizedException('Invalid internal error monitor service key');
    }
  }

  @Post('events')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Internal allowlisted service ingestion for sanitized platform error events',
  })
  async ingestInternalEvent(
    @Headers('x-internal-key') internalKey: string | undefined,
    @Body() dto: IngestInternalErrorEventDto,
  ) {
    this.verifyInternalKey(internalKey);
    const data = await this.errorMonitorService.ingestRawEvent({
      ...dto,
      source: dto.source === 'browser' ? 'browser' : 'server',
    });
    return { status: 'accepted', data };
  }

  @Post('browser-events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Authenticated first-party browser boundary error reporting (monitor-only, never triggers email)',
  })
  async ingestBrowserEvent(@Req() req: any, @Body() dto: ReportBrowserErrorDto) {
    const data = await this.errorMonitorService.ingestRawEvent({
      service: dto.service,
      source: 'browser',
      httpMethod: 'BROWSER',
      route: dto.route,
      statusCode: dto.statusCode ?? 500,
      errorCategory: dto.errorCategory ?? 'BROWSER_RUNTIME_ERROR',
      safeSummary: dto.safeSummary ?? 'First-party client boundary error.',
      isFinancialRoute: false,
      requestId: dto.requestId,
      actorUserId: req?.user?.sub ?? null,
    });
    return { status: 'accepted', data };
  }
}

