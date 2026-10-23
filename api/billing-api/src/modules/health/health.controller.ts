import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '@crimfig/shared';
import { DATABASE_TOKEN } from '../database/database.module';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: any) {}
  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check endpoint' })
  check() {
    return {
      status: 'ok',
      service: '@crimfig/billing-api',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      uptime: process.uptime(),
    };
  }

  @Public()
  @Get('ready')
  async readiness() {
    try {
      await this.db.execute('SELECT 1');
      return { status: 'ready', checks: { database: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', checks: { database: 'fail' } });
    }
  }
}
