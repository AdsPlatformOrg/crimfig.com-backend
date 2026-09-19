import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WithdrawalsService } from './withdrawals.service';
import { IsNumber, IsString, Min } from 'class-validator';

export class RequestWithdrawalDto {
  @IsString()
  bankAccountId: string;

  @IsNumber()
  @Min(5)
  amountUsd: number;
}

@ApiTags('Withdrawals')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of withdrawal requests' })
  async getWithdrawals(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const withdrawals = await this.withdrawalsService.getUserWithdrawals(userId);
    return { status: 'success', data: withdrawals };
  }

  @Post()
  @ApiOperation({ summary: 'Submit a new withdrawal request' })
  async requestWithdrawal(@Req() req: any, @Body() dto: RequestWithdrawalDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.withdrawalsService.requestWithdrawal({
      userId,
      bankAccountId: dto.bankAccountId,
      amountUsd: dto.amountUsd,
    });
    return { status: 'success', data: result };
  }
}
