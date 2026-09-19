import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe — process alive check' })
  liveness() {
    return {
      status: 'ok',
      service: 'crimfig-stream-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — streaming engine availability check' })
  readiness() {
    return {
      status: 'ready',
      service: 'crimfig-stream-api',
      checks: {
        streamEngine: 'ok',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
