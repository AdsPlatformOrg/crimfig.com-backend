import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  Headers,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Response } from 'express';
import { ConversionsService } from './conversions.service';
import { IsString, IsOptional, IsNumber } from 'class-validator';

export class IngestConversionDto {
  @IsString()
  event: string;

  @IsOptional()
  @IsString()
  clickId?: string;

  @IsOptional()
  @IsString()
  orderId?: string;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  metadata?: Record<string, any>;
}

export class CreateApiKeyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  scopes?: string;
}

export class ReverseConversionDto {
  @IsString()
  reason: string;
}

@ApiTags('Ads Conversions & Attribution')
@Controller('api/v1')
export class ConversionsController {
  constructor(private readonly conversionsService: ConversionsService) {}

  /**
   * Public script serving endpoint for browser conversion pixel
   * GET /api/v1/px.js
   */
  @Get('px.js')
  @ApiOperation({ summary: 'Serve lightweight browser conversion tracking pixel' })
  getPixelScript(@Res() res: Response) {
    const script = this.conversionsService.getPixelScript();
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(script);
  }

  /**
   * Beacon collector endpoint called by px.js
   * POST /api/v1/px/collect
   */
  @Post('px/collect')
  @HttpCode(204)
  @ApiOperation({ summary: 'Browser pixel beacon collection' })
  async collectPixel(@Body() body: any) {
    if (!body || !body.advertiserId || !body.event) {
      return;
    }

    await this.conversionsService.ingestConversion({
      advertiserId: body.advertiserId,
      clickId: body.clickId,
      event: body.event,
      orderId: body.orderId,
      value: body.value ? Number(body.value) : undefined,
      currency: body.currency,
      metadata: body.metadata,
      source: 'pixel',
    });
  }

  /**
   * Server-to-server (S2S) postback conversion ingestion
   * POST /api/v1/conversions
   */
  @Post('conversions')
  @ApiOperation({ summary: 'Record S2S conversion postback' })
  async reportS2SConversion(
    @Headers('authorization') authHeader: string,
    @Body() dto: IngestConversionDto,
  ) {
    const rawKey = authHeader?.replace(/^Bearer\s+/i, '');

    const result = await this.conversionsService.ingestConversion({
      apiKey: rawKey,
      clickId: dto.clickId,
      event: dto.event,
      orderId: dto.orderId,
      value: dto.value,
      currency: dto.currency,
      metadata: dto.metadata,
      source: 's2s',
    });

    return { status: 'success', data: result };
  }

  /**
   * List conversions for an advertiser
   * GET /api/v1/conversions
   */
  @Get('conversions')
  @ApiOperation({ summary: 'List conversions for authenticated advertiser' })
  async getConversions(
    @Req() req: any,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit = '50',
  ) {
    const advertiserId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const data = await this.conversionsService.getConversions(advertiserId, {
      campaignId,
      limit: Number(limit),
    });
    return { status: 'success', data };
  }

  /**
   * Reverse conversion within 72h holdback (e.g. order cancelled / refunded)
   * POST /api/v1/conversions/:id/reverse
   */
  @Post('conversions/:id/reverse')
  @ApiOperation({ summary: 'Reverse conversion within 72h holdback' })
  async reverseConversion(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: ReverseConversionDto,
  ) {
    const advertiserId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.conversionsService.reverseConversion(id, advertiserId, dto.reason);
    return { status: 'success', data: result };
  }

  /**
   * List advertiser API keys
   * GET /api/v1/advertisers/api-keys
   */
  @Get('advertisers/api-keys')
  @ApiOperation({ summary: 'List advertiser API keys' })
  async listApiKeys(@Req() req: any) {
    const advertiserId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const keys = await this.conversionsService.listApiKeys(advertiserId);
    return { status: 'success', data: keys };
  }

  /**
   * Generate an API key for S2S conversion reporting
   * POST /api/v1/advertisers/api-keys
   */
  @Post('advertisers/api-keys')
  @ApiOperation({ summary: 'Create new advertiser API key' })
  async createApiKey(@Req() req: any, @Body() dto: CreateApiKeyDto) {
    const advertiserId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const key = await this.conversionsService.createApiKey({
      advertiserId,
      name: dto.name,
      scopes: dto.scopes,
    });
    return { status: 'success', data: key };
  }

  /**
   * Revoke an advertiser API key
   * DELETE /api/v1/advertisers/api-keys/:id
   */
  @Delete('advertisers/api-keys/:id')
  @ApiOperation({ summary: 'Revoke advertiser API key' })
  async revokeApiKey(@Param('id') id: string, @Req() req: any) {
    const advertiserId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.conversionsService.revokeApiKey(id, advertiserId);
    return { status: 'success', data: result };
  }
}
