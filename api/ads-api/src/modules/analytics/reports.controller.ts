import { BadRequestException, Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReportsService } from './reports.service';

@ApiTags('Analytics')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Read daily financial and delivery reports for the signed-in account' })
  async daily(
    @Req() req: { user: { sub: string } },
    @Query('role') role = 'advertiser',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('compare') compare?: string,
  ) {
    if ((role !== 'advertiser' && role !== 'promoter') ||
      (compare !== undefined && compare !== 'true' && compare !== 'false') ||
      (from !== undefined && typeof from !== 'string') || (to !== undefined && typeof to !== 'string')) {
      throw new BadRequestException('Invalid report filters.');
    }
    return { status: 'success', data: await this.reports.daily(req.user.sub, role, from, to, compare === 'true') };
  }
}
