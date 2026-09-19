import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { IsNumber, IsOptional, IsBoolean, IsString, Min } from 'class-validator';

export class FundWalletDto {
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
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @ApiOperation({ summary: 'Get current user wallet balance and NGN equivalent' })
  async getBalance(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const balance = await this.walletService.getBalance(userId);
    return { status: 'success', data: balance };
  }

  @Post('fund')
  @ApiOperation({ summary: 'Initialize wallet funding (USD -> NGN via Paystack)' })
  async fundWallet(@Req() req: any, @Body() dto: FundWalletDto) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const userEmail = req.user?.email || req.headers['x-user-email'] || 'user@crimfig.com';

    const result = await this.walletService.initializeFunding({
      userId,
      userEmail,
      amountUsd: dto.amountUsd,
      saveCard: dto.saveCard,
      savedCardId: dto.savedCardId,
      callbackUrl: dto.callbackUrl,
    });

    return { status: 'success', data: result };
  }

  @Get('verify/:reference')
  @ApiOperation({ summary: 'Verify wallet funding payment by reference' })
  async verifyFunding(@Param('reference') reference: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'];
    const result = await this.walletService.verifyFunding(reference, userId);
    return { status: 'success', data: result };
  }
}
