import { Controller, Get, Post, Body, Req, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WithdrawalsService } from './withdrawals.service';
import { IsNumber, IsUUID, Max, Min } from 'class-validator';

export class QuoteWithdrawalDto {
  @IsUUID('4')
  requestId: string;

  @IsUUID()
  bankAccountId: string;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(5)
  @Max(21474836.47)
  amountUsd: number;
}

export class RequestWithdrawalDto extends QuoteWithdrawalDto {
  @IsUUID('4')
  quoteId: string;
}

@ApiTags('Withdrawals')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of withdrawal requests' })
  async getWithdrawals(@Req() req: any) {
    const userId = req.user.sub;
    const withdrawals = await this.withdrawalsService.getUserWithdrawals(userId);
    return { status: 'success', data: withdrawals };
  }

  @Post()
  @ApiOperation({ summary: 'Submit a new withdrawal request' })
  async requestWithdrawal(@Req() req: any, @Body() dto: RequestWithdrawalDto) {
    const userId = req.user.sub;
    const result = await this.withdrawalsService.requestWithdrawal({
      userId,
      requestId: dto.requestId,
      quoteId: dto.quoteId,
      bankAccountId: dto.bankAccountId,
      amountUsd: dto.amountUsd,
    });
    return { status: 'success', data: result };
  }
  @Post('quote')
  @ApiOperation({ summary: 'Quote withdrawal fees, levy, exchange rate and net payout before confirmation' })
  async quote(@Req() req: any, @Body() dto: QuoteWithdrawalDto) {
    return { status: 'success', data: await this.withdrawalsService.quoteWithdrawal({ userId: req.user.sub,
      requestId: dto.requestId, bankAccountId: dto.bankAccountId, amountUsd: dto.amountUsd }) };
  }

  @Get('requests/:requestId')
  @ApiOperation({ summary: 'Recover an owned durable withdrawal request after a lost creation response' })
  async recoverRequest(@Req() req: any, @Param('requestId') requestId: string) {
    return { status: 'success', data: await this.withdrawalsService.recoverRequest(req.user.sub, requestId) };
  }

  @Get(':reference/status')
  @ApiOperation({ summary: 'Recover an owned withdrawal using provider verification; never re-dispatch' })
  async recover(@Req() req: any, @Param('reference') reference: string) {
    return { status: 'success', data: await this.withdrawalsService.recoverWithdrawal(req.user.sub, reference) };
  }

  @Post(':reference/dispatch')
  @ApiOperation({ summary: 'Explicitly dispatch an owned undispatched reservation at most once' })
  async dispatch(@Req() req: any, @Param('reference') reference: string) {
    return { status: 'success', data: await this.withdrawalsService.dispatchWithdrawal(req.user.sub, reference) };
  }

  @Post(':reference/cancel')
  @ApiOperation({ summary: 'Cancel an owned reservation only before provider dispatch ownership' })
  async cancel(@Req() req: any, @Param('reference') reference: string) {
    return { status: 'success', data: await this.withdrawalsService.cancelWithdrawal(req.user.sub, reference) };
  }

}
