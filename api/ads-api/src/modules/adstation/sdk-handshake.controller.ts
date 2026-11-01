import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@crimfig/shared';
import { SdkHandshakeDto, SetupChecksService } from './setup-checks.service';

function originHost(req: any): string | undefined {
  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || !origin) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return 'invalid.invalid'; // malformed Origin never matches a website domain
  }
}

@ApiTags('Ad Delivery & Embed')
@Controller('delivery')
export class SdkHandshakeController {
  constructor(private readonly checks: SetupChecksService) {}

  @Public()
  @Post('sdk-handshake')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Scoped SDK execution acknowledgement for setup checks (no slot required)' })
  async handshake(@Body() dto: SdkHandshakeDto, @Req() req: any) {
    // Always 204: callers cannot probe which challenges exist.
    await this.checks.acknowledgeSdk(dto, originHost(req));
  }
}

