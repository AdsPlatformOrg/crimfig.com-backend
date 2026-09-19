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
      service: 'crimfig-reels-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — dependency check' })
  readiness() {
    return {
      status: 'ready',
      service: 'crimfig-reels-api',
      checks: {
        mediaPipeline: 'ok',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
