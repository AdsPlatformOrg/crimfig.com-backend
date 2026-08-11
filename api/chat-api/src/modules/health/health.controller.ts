import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DATABASE_TOKEN } from '../database/database.module';

@ApiTags('Health')
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
      service: 'crimfig-chat-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — DB connectivity check' })
  async readiness() {
    try {
      await this.db.execute('SELECT 1');
      return {
        status: 'ready',
        checks: { database: 'ok' },
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'not_ready',
        checks: { database: 'fail' },
        timestamp: new Date().toISOString(),
      };
    }
  }
}
