import { Controller, Get, Post, Query, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ExchangeRateService } from './exchange-rate.service';

@ApiTags('Exchange Rates')
@Controller('exchange-rates')
export class ExchangeRateController {
  constructor(private readonly fxService: ExchangeRateService) {}

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
        providerUpdatedAt: fx.providerUpdatedAt,
      },
    };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Force refresh USD/NGN exchange rate from live providers' })
  async forceRefresh() {
    throw new ServiceUnavailableException('Manual provider refresh is unavailable pending operator rate-limit controls');
  }

  @Get('convert')
  @ApiOperation({ summary: 'Convert USD cents to NGN or NGN kobo to USD' })
  async convert(
    @Query('usdCents') usdCents?: string,
    @Query('ngnKobo') ngnKobo?: string,
  ) {
    if ((usdCents === undefined) === (ngnKobo === undefined)) throw new BadRequestException('Provide exactly one conversion amount');
    const raw = usdCents ?? ngnKobo!;
    if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new BadRequestException('Use non-negative integer minor units');
    const result = usdCents !== undefined
      ? await this.fxService.convertUsdCentsToNgn(Number(raw))
      : await this.fxService.convertNgnKoboToUsdCents(Number(raw));
    return { status: 'success', data: result };
  }

  @Get('history')
  @ApiOperation({ summary: 'Get historical exchange rate snapshots' })
  async getHistory(@Query('limit') limit?: string) {
    if (limit !== undefined && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new BadRequestException('History limit must be between 1 and 100');
    const count = limit === undefined ? 30 : Number(limit);
    const history = await this.fxService.getHistory(count);
    return { status: 'success', data: history.map(row => ({ id: row.id, rate: row.usdToNgn, source: row.source, fetchedAt: row.fetchedAt })) };
  }
}
