import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FinancialOperation } from '@crimfig/shared';
import { WalletService } from './wallet.service';
import { IsNumber, IsOptional, IsBoolean, IsString, Min, IsUUID } from 'class-validator';

export class FundWalletDto {
  @IsUUID('4')
  requestId: string;

  @IsNumber()
  @Min(1)
  amountUsd: number;

  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;

  @IsOptional()
  @IsString()
  savedCardId?: string;

  @IsOptional()
  @IsString()
  callbackUrl?: string;
}

@ApiTags('Wallet')
@FinancialOperation('wallet')
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user wallet balance and NGN equivalent' })
  async getBalance(@Req() req: any) {
    const userId = req.user.sub;
    const balance = await this.walletService.getBalance(userId);
    return { status: 'success', data: balance };
  }

  @Post('fund')
  @ApiOperation({ summary: 'Initialize wallet funding (USD -> NGN via Paystack)' })
  async fundWallet(@Req() req: any, @Body() dto: FundWalletDto) {
    const userId = req.user.sub;
    const userEmail = req.user.email;

    const result = await this.walletService.initializeFunding({
      userId,
      userEmail,
      amountUsd: dto.amountUsd,
      requestId: dto.requestId,
      saveCard: dto.saveCard,
      savedCardId: dto.savedCardId,
      callbackUrl: dto.callbackUrl,
    });

    return { status: 'success', data: result };
  }

  @Get('funding-requests/:requestId')
  @ApiOperation({ summary: 'Recover the authenticated owner funding request without initializing another provider payment' })
  async recoverFundingRequest(@Param('requestId') requestId: string, @Req() req: any) {
    return { status: 'success', data: await this.walletService.recoverFundingRequest(req.user.sub, requestId) };
  }

  @Get('verify/:reference')
  @ApiOperation({ summary: 'Verify wallet funding payment by reference' })
  async verifyFunding(@Param('reference') reference: string, @Req() req: any) {
    const userId = req.user.sub;
    const result = await this.walletService.verifyFunding(reference, userId);
    return { status: 'success', data: result };
  }
}
