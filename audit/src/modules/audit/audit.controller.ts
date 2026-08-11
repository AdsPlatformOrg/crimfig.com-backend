import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditService } from './audit.service';

export class LogEventDto {
  @ApiPropertyOptional() @IsOptional() @IsString() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() organizationId?: string;
  @ApiProperty() @IsString() action!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resourceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resourceId?: string;
  @ApiPropertyOptional() @IsOptional() metadata?: Record<string, any>;
  @ApiPropertyOptional() @IsOptional() @IsString() ipAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() userAgent?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() requestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() success?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() errorCode?: string;
}

export class QueryAuditLogsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() organizationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resourceType?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 20;
}

@ApiTags('Audit Logs')
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post('logs')
  @ApiOperation({ summary: 'Ingest an audit log event directly via REST' })
  recordLog(@Body() dto: LogEventDto) {
    return this.auditService.recordLog(dto);
  }

  @Get('logs')
  @ApiOperation({ summary: 'Query audit logs with filtering & pagination' })
  queryLogs(@Query() query: QueryAuditLogsDto) {
    return this.auditService.queryLogs(query);
  }
}
