import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ExchangeRateService } from './exchange-rate.service';
import { Public } from '@crimfig/shared';

@ApiTags('Exchange Rates')
@Controller('exchange-rates')
export class ExchangeRateController {
  constructor(private readonly fxService: ExchangeRateService) {}

  @Public()
  @Get('current')
  @ApiOperation({ summary: 'Get current USD/NGN exchange rate' })
  async getCurrentRate() {
    const fx = await this.fxService.getUsdToNgnRate();
    return {
      status: 'success',
      data: {
        baseCurrency: 'USD',
        targetCurrency: 'NGN',
        rate: fx.rate,
        rateId: fx.rateId,
        source: fx.source,
        fetchedAt: fx.fetchedAt,
      },
    };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Force refresh USD/NGN exchange rate from live providers' })
  async forceRefresh() {
    const fx = await this.fxService.getUsdToNgnRate(true);
    return {
      status: 'success',
      data: {
        baseCurrency: 'USD',
        targetCurrency: 'NGN',
        rate: fx.rate,
        rateId: fx.rateId,
        source: fx.source,
        fetchedAt: fx.fetchedAt,
      },
    };
  }

  @Public()
  @Get('convert')
  @ApiOperation({ summary: 'Convert USD cents to NGN or NGN kobo to USD' })
  async convert(
    @Query('usdCents') usdCents?: string,
    @Query('ngnKobo') ngnKobo?: string,
  ) {
    if (usdCents) {
      const result = await this.fxService.convertUsdCentsToNgn(parseInt(usdCents, 10));
      return { status: 'success', data: result };
    }
    if (ngnKobo) {
      const result = await this.fxService.convertNgnKoboToUsdCents(parseInt(ngnKobo, 10));
      return { status: 'success', data: result };
    }
    return { status: 'error', message: 'Provide either usdCents or ngnKobo query parameter' };
  }

  @Public()
  @Get('history')
  @ApiOperation({ summary: 'Get historical exchange rate snapshots' })
  async getHistory(@Query('limit') limit?: string) {
    const count = limit ? parseInt(limit, 10) : 30;
    const history = await this.fxService.getHistory(count);
    return { status: 'success', data: history };
  }
}
