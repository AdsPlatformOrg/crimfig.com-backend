import { Controller, Get, Post, Body, Param, Query, Req, Res, Header, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { resolveClientIp, resolveClaimedIp } from './client-ip';
import { Public } from '@crimfig/shared';
import type { Response, Request } from 'express';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, IsUUID, IsISO8601 } from 'class-validator';

function pickClaims(dto: any) {
  return {
    pageViewId: dto.pageViewId,
    slotInstanceId: dto.slotInstanceId,
    opportunityId: dto.opportunityId,
    sdkInitId: dto.sdkInitializationId,
    instanceIndex: dto.instanceIndex,
    instancesDetected: dto.instancesDetected,
  };
}

function extractClientIp(req: Request): string {
  // PLAN-0066 F1: explicit trusted-proxy boundary (see client-ip.ts).
  return resolveClientIp(req as any);
}

/**
 * Read geography only from a header explicitly configured as trusted-edge
 * output. Without TRUST_PROXY_GEO=true, geo-targeted ads fail closed.
 */
function trustedClientGeo(req: Request): { country?: string; region?: string; city?: string } | undefined {
  if ((process.env.TRUST_PROXY_GEO || 'false').toLowerCase() !== 'true') return undefined;
  const header = (value: string | undefined) => (value && value !== 'unknown' ? value : undefined);
  const countryHeader = (process.env.TRUSTED_GEO_COUNTRY_HEADER || 'cf-ipcountry').toLowerCase();
  const regionHeader = (process.env.TRUSTED_GEO_REGION_HEADER || 'cf-region-code').toLowerCase();
  const cityHeader = (process.env.TRUSTED_GEO_CITY_HEADER || '').toLowerCase();
  const country = header(req.headers[countryHeader] as string | undefined)?.toUpperCase();
  const region = header(req.headers[regionHeader] as string | undefined)?.toUpperCase();
  const city = cityHeader ? header(req.headers[cityHeader] as string | undefined) : undefined;
  if (!country && !region && !city) return undefined;
  return { country, region, city };
}

export class AuditPingDto {
  @IsOptional() @IsString() @MaxLength(200)
  placementToken?: string;
  @IsOptional() @IsString() @MaxLength(255)
  domain?: string;
  @IsOptional() @IsString() @MaxLength(255)
  bundleId?: string;
}

export class TrackInteractionDto {
  @IsOptional() @IsUUID() eventId?:string;
  @IsOptional() @IsISO8601() occurredAt?:string;
  @IsOptional() @IsString() @MaxLength(200)
  placementToken?: string;
  @IsOptional() @IsString() @MaxLength(2048)
  impToken?: string;
  @IsIn(['hover', 'touch', 'render', 'impression', 'viewable_impression', 'click', 'reels_view', 'video_q25', 'video_q50', 'video_q75', 'video_complete'])
  type: 'hover' | 'touch' | 'render' | 'impression' | 'viewable_impression' | 'click' | 'reels_view' | 'video_q25' | 'video_q50' | 'video_q75' | 'video_complete';
  @IsOptional() @IsIn(['embed', 'share_link', 'reels', 'direct'])
  source?: string;
  // PLAN-0066 F4: optional browser-claimed correlation. Never authority; legacy tags omit these.
  @IsOptional() @IsUUID() pageViewId?: string;
  @IsOptional() @IsUUID() slotInstanceId?: string;
  @IsOptional() @IsUUID() opportunityId?: string;
  @IsOptional() @IsUUID() sdkInitializationId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) instanceIndex?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) instancesDetected?: number;}

export class ViewabilityTelemetryDto {
  @IsOptional() @IsUUID() eventId?:string;
  @IsOptional() @IsISO8601() occurredAt?:string;
  @IsString() @MaxLength(2048)
  impToken: string;
  @IsNumber() @Min(0) @Max(1)
  visibleRatio: number;
  @IsNumber() @Min(0) @Max(900)
  durationSeconds: number;
  @IsOptional() @IsIn(['banner', 'card', 'video', 'interstitial'])
  format?: string;
  // PLAN-0066 F4: optional browser-claimed correlation. Never authority; legacy tags omit these.
  @IsOptional() @IsUUID() pageViewId?: string;
  @IsOptional() @IsUUID() slotInstanceId?: string;
  @IsOptional() @IsUUID() opportunityId?: string;
  @IsOptional() @IsUUID() sdkInitializationId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) instanceIndex?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1000) instancesDetected?: number;}

@ApiTags('Ad Delivery & Embed')
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Public()
  @Post('viewability')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Record client-reported viewability telemetry; not independent measurement proof' })
  async logViewability(@Body() dto: ViewabilityTelemetryDto, @Req() req: Request) {
    const clientIp = extractClientIp(req);
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    await this.deliveryService.logInteraction({
      impToken: dto.impToken,
      eventId:dto.eventId,occurredAt:dto.occurredAt,
      type: 'viewable_impression',
      source: 'embed',
      clientIp,
      claimedIp: resolveClaimedIp(req as any),
      claims: pickClaims(dto),
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
      impToken: dto.impToken,
      eventId:dto.eventId,occurredAt:dto.occurredAt,
      type: dto.type,
      source: dto.source,
      clientIp,
      claimedIp: resolveClaimedIp(req as any),
      claims: pickClaims(dto),
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
    @Query('mode') mode?: string,
    @Query('fill') fill?: string,
    @Query('consent') consent?:string,
    @Req() req?: Request,
  ) {
    const clientIp = req ? extractClientIp(req) : undefined;
    const userAgent = req?.headers['user-agent'];

    const ad = await this.deliveryService.getAdForPlacement(
      token,
      clientIp,
      userAgent,
      domain,
      mode,
      fill === 'true',
      req ? trustedClientGeo(req) : undefined,
      req
        ? {
            measurementConsent: consent === 'granted',
            consentState: consent === 'granted' || consent === 'denied' ? consent : 'unknown',
            origin: req.headers['origin'] as string | undefined,
            referer: req.headers['referer'] as string | undefined,
          }
        : undefined,
    );
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

  @Public()
  @Get('sdk/config')
  @ApiOperation({ summary: 'Remote configuration for Mobile SDKs (React Native / Native)' })
  getSdkConfig(
    @Query('appKey') appKey: string,
    @Query('platform') platform = 'android',
    @Query('sdkVersion') sdkVersion = '1.0.0',
  ) {
    throw new ServiceUnavailableException('Mobile ad SDK configuration is unavailable pending verified application registration and attestation');
  }

  @Public()
  @Post('app-session')
  @ApiOperation({ summary: 'Exchange Play Integrity or App Attest token for signed session token' })
  createAppSession(@Body() dto: { appKey?: string; platform?: string; bundleId?: string; attestationToken?: string }) {
    throw new ServiceUnavailableException('Mobile attestation is unavailable pending provider verification');
  }

  @Public()
  @Post('reward-verify')
  @ApiOperation({ summary: 'Verify completed rewarded video ad playback and issue signed publisher reward token' })
  verifyReward(@Body() dto: { impToken?: string; sessionKey?: string; userId?: string }) {
    throw new ServiceUnavailableException('Reward issuance is unavailable pending verified playback and funded reward eligibility');
  }

  @Public()
  @Get('adstation/health')
  @ApiOperation({ summary: 'Public delivery route probe and CORS health check for AdStation' })
  getAdstationDeliveryHealth() {
    return {
      status: 'success',
      data: {
        service: 'adstation-delivery',
        deliveryMode: 'wildcard-cors',
        timestamp: new Date().toISOString(),
      },
    };
  }
}
