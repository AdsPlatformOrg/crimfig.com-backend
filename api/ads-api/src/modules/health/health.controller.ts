import { requiredAdsSchema } from './required-schema';
import { Public } from '@crimfig/shared';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DATABASE_TOKEN } from '../database/database.module';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: any,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe — process alive check' })
  liveness() {
    return {
      status: 'ok',
      service: 'crimfig-ads-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — DB connectivity check' })
  async readiness() {
    try {
      await requiredAdsSchema(this.db);
      return {
        status: 'ready',
      revision: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
        checks: { database: 'ok', schema: 'ok' },
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { database: 'unavailable', schema: 'unavailable' },
        timestamp: new Date().toISOString(),
      });
    }
  }
}
