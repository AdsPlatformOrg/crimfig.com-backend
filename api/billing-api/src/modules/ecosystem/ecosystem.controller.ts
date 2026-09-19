import { Controller, Get, Post, Body, Param, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WalletService } from '../wallet/wallet.service';
import { IsNumber, IsString, Min } from 'class-validator';
import { Public } from '@crimfig/shared';

export class LockBudgetDto {
  @IsNumber()
  @Min(1)
  amountUsdCents: number;

  @IsString()
  reason: string;
}

export class DeductSpendDto {
  @IsNumber()
  @Min(1)
  amountUsdCents: number;

  @IsString()
  campaignId: string;

  @IsString()
  description: string;
}

export class CreditEarningDto {
  @IsNumber()
  @Min(1)
  amountUsdCents: number;

  @IsString()
  promoterId: string;

  @IsString()
  description: string;
}

@ApiTags('Internal Ecosystem')
@Controller('ecosystem')
export class EcosystemController {
  private readonly internalApiKey = process.env.INTERNAL_ECOSYSTEM_KEY || 'crimfig-internal-eco-key-2026';

  constructor(private readonly walletService: WalletService) {}

  private verifyInternalKey(providedKey: string) {
    if (process.env.NODE_ENV === 'production' && providedKey !== this.internalApiKey) {
      throw new UnauthorizedException('Invalid internal ecosystem authorization');
    }
  }

  @Public()
  @Get('wallets/:userId/balance')
  @ApiOperation({ summary: 'Internal: Check user wallet balance for ads / ecosystem services' })
  async getBalance(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
  ) {
    this.verifyInternalKey(key);
    const balance = await this.walletService.getBalance(userId);
    return { status: 'success', data: balance };
  }

  @Public()
  @Post('wallets/:userId/lock')
  @ApiOperation({ summary: 'Internal: Lock campaign budget from available balance' })
  async lockFunds(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: LockBudgetDto,
  ) {
    this.verifyInternalKey(key);
    await this.walletService.lockFunds(userId, dto.amountUsdCents, dto.reason);
    return { status: 'success', message: 'Funds locked successfully' };
  }

  @Public()
  @Post('wallets/:userId/unlock')
  @ApiOperation({ summary: 'Internal: Unlock campaign budget back to available balance' })
  async unlockFunds(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: LockBudgetDto,
  ) {
    this.verifyInternalKey(key);
    await this.walletService.unlockFunds(userId, dto.amountUsdCents, dto.reason);
    return { status: 'success', message: 'Funds unlocked successfully' };
  }

  @Public()
  @Post('wallets/:userId/deduct-spend')
  @ApiOperation({ summary: 'Internal: Realize ad spend deduction from locked balance' })
  async deductSpend(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: DeductSpendDto,
  ) {
    this.verifyInternalKey(key);
    await this.walletService.deductLockedFunds(userId, dto.amountUsdCents, dto.description);
    return { status: 'success', message: 'Spend deducted successfully' };
  }

  @Public()
  @Post('wallets/:userId/credit-earning')
  @ApiOperation({ summary: 'Internal: Credit promoter earnings to wallet' })
  async creditEarning(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: CreditEarningDto,
  ) {
    this.verifyInternalKey(key);
    await this.walletService.creditEarnings(userId, dto.amountUsdCents, dto.description);
    return { status: 'success', message: 'Earnings credited to wallet' };
  }
}
