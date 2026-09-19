import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';

@ApiTags('Transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'Get paginated transaction history' })
  async getTransactions(
    @Req() req: any,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.transactionsService.getUserTransactions(userId, {
      type,
      status,
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { status: 'success', data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single transaction receipt details' })
  async getTransaction(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const tx = await this.transactionsService.getTransactionById(userId, id);
    return { status: 'success', data: tx };
  }
}
