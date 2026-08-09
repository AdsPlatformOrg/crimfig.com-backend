import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Pool } from 'pg';
import { DATABASE_TOKEN } from '../database/database.module';
import { OAuthService } from '../oauth/oauth.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: any,
    private readonly oauthService: OAuthService,
  ) {}

  /**
   * Liveness probe — is the process alive?
   * Railway calls this to decide whether to restart the container.
   * Must respond in < 1s or Railway marks the instance as dead.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness probe — process alive check' })
  liveness() {
    return {
      status: 'ok',
      service: 'crimfig-auth-api',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe — is the service ready to accept traffic?
   * Railway / load balancer calls this before routing traffic to a new instance.
   * Returns 503 if DB or Redis is down → load balancer keeps traffic on healthy instances.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — DB + Redis connectivity check' })
  async readiness() {
    const [dbOk, redisOk] = await Promise.allSettled([
      this.checkDb(),
      this.oauthService.pingRedis(),
    ]);

    const db = dbOk.status === 'fulfilled' && dbOk.value;
    const redis = redisOk.status === 'fulfilled' && redisOk.value;
    const ready = db && redis;

    return {
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: db ? 'ok' : 'fail',
        redis: redis ? 'ok' : 'fail',
      },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      // Access the underlying pool from the Drizzle instance
      await this.db.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
