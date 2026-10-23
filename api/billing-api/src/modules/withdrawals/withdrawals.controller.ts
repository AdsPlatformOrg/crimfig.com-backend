import { RefundReviewService } from './refund-review.service';
import { Controller, Get, Post, Body, Req, Param, ForbiddenException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WithdrawalsService } from './withdrawals.service';
import { IsNumber, IsUUID, Max, Min, IsString, IsIn, IsInt, MaxLength } from 'class-validator';

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

export class RegisterRefundEvidenceDto {
  @IsString()
  transferCode: string;

  @IsIn(['failed', 'reversed'])
  outcome: 'failed' | 'reversed';

  @IsString()
  providerEvidenceId: string;

  @IsString()
  preparedBy: string;

  @IsString()
  reviewedBy: string;

  @IsNumber()
  @Min(0)
  retainedFeeKobo: number;

  @IsNumber()
  @Min(0)
  retainedStampDutyKobo: number;
}

export class PrepareRefundReviewDto {
  @IsString()
  @MaxLength(200)
  providerEvidenceId: string;
  @IsInt()
  @Min(0)
  @Max(2147483647)
  retainedFeeKobo: number;
  @IsInt()
  @Min(0)
  @Max(2147483647)
  retainedStampDutyKobo: number;
}
export class ApproveRefundReviewDto {
  @IsUUID()
  draftId: string;
}

@ApiTags('Withdrawals')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawalsService: WithdrawalsService, @Optional() private readonly refundReview?: RefundReviewService) {}

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

  @Post(':reference/refund-evidence/prepare')
  async prepareRefund(@Req() req: any, @Param('reference') reference: string, @Body() dto: PrepareRefundReviewDto) {
    if (!this.refundReview) throw new ServiceUnavailableException('Refund review unavailable');
    return { status: 'success', data: await this.refundReview.prepare(req.user.sub, reference, {
      providerEvidenceId: dto.providerEvidenceId, retainedFeeKobo: dto.retainedFeeKobo, retainedStampDutyKobo: dto.retainedStampDutyKobo,
    }) };
  }
  @Get(':reference/refund-evidence')
  async readRefund(@Req() req: any, @Param('reference') reference: string) {
    if (!this.refundReview) throw new ServiceUnavailableException('Refund review unavailable');
    return { status: 'success', data: await this.refundReview.read(req.user.sub, reference) };
  }
  @Post(':reference/refund-evidence/approve')
  async approveRefund(@Req() req: any, @Param('reference') reference: string, @Body() dto: ApproveRefundReviewDto) {
    if (!this.refundReview) throw new ServiceUnavailableException('Refund review unavailable');
    return { status: 'success', data: await this.refundReview.approve(req.user.sub, reference, dto.draftId) };
  }

  @Post(':reference/refund-evidence')
  @ApiOperation({ summary: 'Operator: Register verified provider evidence receipt for failed/reversed fee reconciliation' })
  async registerRefundEvidence(
    @Req() req: any,
    @Param('reference') reference: string,
    @Body() dto: RegisterRefundEvidenceDto,
  ) {
    // A signed-in owner is not an operator, and two body strings are not dual approval.
    // Keep this legacy route closed until server-authorized preparation and independent review exist.
    void req; void reference; void dto;
    throw new ForbiddenException('Refund evidence requires an authorized independent operator review workflow');
  }
}
