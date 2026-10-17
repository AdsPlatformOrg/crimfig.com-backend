import { Controller, Get, Post, Body, Param, Query, Req, Res, Header, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { Public } from '@crimfig/shared';
import type { Response, Request } from 'express';

function extractClientIp(req: Request): string {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string') {
    // Leftmost entry represents the original client before proxies
    return xForwardedFor.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

export class AuditPingDto {
  placementToken?: string;
  domain?: string;
  bundleId?: string;
}

export class TrackInteractionDto {
  placementToken?: string;
  impToken?: string;
  type: 'hover' | 'touch' | 'impression' | 'viewable_impression' | 'click' | 'reels_view' | 'video_q25' | 'video_q50' | 'video_q75' | 'video_complete';
  source?: string;
}

export class ViewabilityTelemetryDto {
  impToken: string;
  visibleRatio: number;
  durationSeconds: number;
  format?: string;
}

@ApiTags('Ad Delivery & Embed')
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Public()
  @Post('viewability')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Log verified viewability telemetry (IAB 50%/1s continuous standard)' })
  async logViewability(@Body() dto: ViewabilityTelemetryDto, @Req() req: Request) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    await this.deliveryService.logInteraction({
      impToken: dto.impToken,
      type: 'viewable_impression',
      source: 'embed',
      clientIp,
      userAgent,
      referrer,
      visibleRatio: dto.visibleRatio,
      durationSeconds: dto.durationSeconds,
    });
  }

  @Public()
  @Get('pub-loader.js')
  @Header('Content-Type', 'application/javascript')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Modern production ad loader for publisher networks' })
  getPubLoaderScript(@Res() res: Response) {
    const script = this.deliveryService.getEmbedScript();
    res.send(script);
  }

  @Public()
  @Get('embed.js')
  @Header('Content-Type', 'application/javascript')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Embed script for publisher websites (legacy fallback)' })
  getEmbedScript(@Res() res: Response) {
    const script = this.deliveryService.getEmbedScript();
    res.send(script);
  }

  @Public()
  @Post('audit-ping')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Non-blocking embed execution ping logging' })
  async auditPing(@Body() dto: AuditPingDto, @Req() req: Request) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    await this.deliveryService.logAuditPing({
      placementToken: dto.placementToken,
      domain: dto.domain,
      bundleId: dto.bundleId,
      clientIp,
      userAgent,
      referrer,
    });
  }

  @Public()
  @Post('interaction')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Track user engagement interaction (hover, touch, impression, click)' })
  async trackInteraction(@Body() dto: TrackInteractionDto, @Req() req: Request) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    await this.deliveryService.logInteraction({
      placementToken: dto.placementToken,
      type: dto.type,
      source: dto.source,
      clientIp,
      userAgent,
      referrer,
    });
  }

  @Public()
  @Get('ad/:placementToken')
  @ApiOperation({ summary: 'Fetch ad creative for placement and log impression' })
  async getAd(
    @Param('placementToken') token: string,
    @Query('domain') domain: string,
    @Req() req: Request,
  ) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];

    const ad = await this.deliveryService.getAdForPlacement(token, clientIp, userAgent, domain);
    return { status: 'success', data: ad };
  }

  @Public()
  @Get('go/:placementToken')
  @ApiOperation({ summary: 'Public click redirect endpoint for share links and ads' })
  async handleClick(
    @Param('placementToken') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    const destinationUrl = await this.deliveryService.handleClick(token, clientIp, userAgent, referrer);
    res.redirect(302, destinationUrl);
  }
}
