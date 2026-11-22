import { Public } from '@crimfig/shared';
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
  ServiceUnavailableException,
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
@Controller()
export class ConversionsController {
  constructor(private readonly conversionsService: ConversionsService) {}

  /**
   * Public script serving endpoint for browser conversion pixel
   * GET /api/v1/px.js
   */
  @Public()
  @Get('px.js')
  @ApiOperation({ summary: 'Serve lightweight browser conversion tracking pixel (paused)' })
  getPixelScript(@Res() res: Response) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send('/* CrimFig conversion tracking is coming soon and currently paused. */\n');
  }

  /**
   * Beacon collector endpoint called by px.js (paused under PLAN-0152)
   * POST /api/v1/px/collect
   */
  @Public()
  @Post('px/collect')
  @HttpCode(204)
  @ApiOperation({ summary: 'Browser pixel beacon collection (paused)' })
  async collectPixel(@Body() _body: any) {
    return;
  }

  /**
   * Server-to-server (S2S) postback conversion ingestion (paused under PLAN-0152)
   * POST /api/v1/conversions
   */
  @Public()
  @Post('conversions')
  @ApiOperation({ summary: 'Record S2S conversion postback (paused)' })
  async reportS2SConversion(
    @Headers('authorization') _authHeader: string,
    @Body() _dto: IngestConversionDto,
  ) {
    throw new ServiceUnavailableException('Conversion tracking is coming soon and intake is currently paused.');
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
    const advertiserId = req.user.sub;
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
    const advertiserId = req.user.sub;
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
    const advertiserId = req.user.sub;
    const keys = await this.conversionsService.listApiKeys(advertiserId);
    return { status: 'success', data: keys };
  }

  /**
   * Generate an API key for S2S conversion reporting
   * POST /api/v1/advertisers/api-keys
   */
  @Post('advertisers/api-keys')
  @ApiOperation({ summary: 'Create new advertiser API key (paused)' })
  async createApiKey(@Req() _req: any, @Body() _dto: CreateApiKeyDto) {
    throw new ServiceUnavailableException('Conversion API key issuance is coming soon and currently paused.');
  }

  /**
   * Revoke an advertiser API key
   * DELETE /api/v1/advertisers/api-keys/:id
   */
  @Delete('advertisers/api-keys/:id')
  @ApiOperation({ summary: 'Revoke advertiser API key' })
  async revokeApiKey(@Param('id') id: string, @Req() req: any) {
    const advertiserId = req.user.sub;
    const result = await this.conversionsService.revokeApiKey(id, advertiserId);
    return { status: 'success', data: result };
  }
}
