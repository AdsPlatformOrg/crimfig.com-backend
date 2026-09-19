import { Controller, Get, Param, Query, Req, Res, Header } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { Public } from '@crimfig/shared';
import type { Response, Request } from 'express';

@ApiTags('Ad Delivery & Embed')
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Public()
  @Get('embed.js')
  @Header('Content-Type', 'application/javascript')
  @ApiOperation({ summary: 'Embed script for publisher websites' })
  getEmbedScript(@Res() res: Response) {
    const script = this.deliveryService.getEmbedScript();
    res.send(script);
  }

  @Public()
  @Get('ad/:placementToken')
  @ApiOperation({ summary: 'Fetch ad creative for placement and log impression' })
  async getAd(
    @Param('placementToken') token: string,
    @Query('domain') domain: string,
    @Req() req: Request,
  ) {
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress;
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
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const referrer = req.headers['referer'];

    const destinationUrl = await this.deliveryService.handleClick(token, clientIp, userAgent, referrer);
    res.redirect(302, destinationUrl);
  }
}
