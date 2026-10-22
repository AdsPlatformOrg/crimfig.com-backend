import { Controller, Get, Post, Body, Param, Headers, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CampaignEscrowService } from './campaign-escrow.service';
import { WalletService } from '../wallet/wallet.service';
import { IsNumber, IsString, Min, IsIn } from 'class-validator';
import { Public } from '@crimfig/shared';
import { timingSafeEqual } from 'crypto';

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

export class CampaignStatusDto {
  @IsIn(['active', 'paused', 'trash'])
  status: 'active' | 'paused' | 'trash';
}

@ApiTags('Internal Ecosystem')
@Controller('ecosystem')
export class EcosystemController {
  private readonly internalApiKey = process.env.INTERNAL_ECOSYSTEM_KEY;

  constructor(private readonly walletService: WalletService, private readonly campaignEscrow: CampaignEscrowService) {}

  private verifyInternalKey(providedKey: string) {
    if (!this.internalApiKey || typeof providedKey !== 'string' || !providedKey ||
        Buffer.byteLength(providedKey) !== Buffer.byteLength(this.internalApiKey) ||
        !timingSafeEqual(Buffer.from(providedKey), Buffer.from(this.internalApiKey))) {
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
  @ApiOperation({ summary: 'Unavailable legacy operation: Internal: Lock campaign budget from available balance', deprecated: true })
  async lockFunds(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: LockBudgetDto,
  ) {
    this.verifyInternalKey(key);
    throw new ServiceUnavailableException('Legacy wallet mutation is disabled; use the authoritative campaign escrow or funded settlement contract');
  }

  @Public()
  @Post('wallets/:userId/unlock')
  @ApiOperation({ summary: 'Unavailable legacy operation: Internal: Unlock campaign budget back to available balance', deprecated: true })
  async unlockFunds(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: LockBudgetDto,
  ) {
    this.verifyInternalKey(key);
    throw new ServiceUnavailableException('Legacy wallet mutation is disabled; use the authoritative campaign escrow or funded settlement contract');
  }

  @Public()
  @Post('wallets/:userId/deduct-spend')
  @ApiOperation({ summary: 'Unavailable legacy operation: Internal: Realize ad spend deduction from locked balance', deprecated: true })
  async deductSpend(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: DeductSpendDto,
  ) {
    this.verifyInternalKey(key);
    throw new ServiceUnavailableException('Legacy wallet mutation is disabled; use the authoritative campaign escrow or funded settlement contract');
  }

  @Public()
  @Post('wallets/:userId/credit-earning')
  @ApiOperation({ summary: 'Unavailable legacy operation: Internal: Credit promoter earnings to wallet', deprecated: true })
  async creditEarning(
    @Param('userId') userId: string,
    @Headers('x-internal-key') key: string,
    @Body() dto: CreditEarningDto,
  ) {
    this.verifyInternalKey(key);
    throw new ServiceUnavailableException('Legacy wallet mutation is disabled; use the authoritative campaign escrow or funded settlement contract');
  }

  @Public()
  @Post('wallets/:userId/campaign-escrows/:campaignId/reserve')
  @ApiOperation({ summary: 'Internal: Atomically reserve campaign budget with a durable Billing receipt' })
  async reserveCampaign(
    @Param('userId') userId: string, @Param('campaignId') campaignId: string,
    @Headers('x-internal-key') key: string, @Body() dto: LockBudgetDto,
  ) {
    this.verifyInternalKey(key);
    return { status: 'success', data: await this.campaignEscrow.change(userId, campaignId, 'reserve', dto.amountUsdCents) };
  }

  @Public()
  @Post('wallets/:userId/campaign-escrows/:campaignId/release')
  @ApiOperation({ summary: 'Internal: Atomically release the stopped campaign reservation' })
  async releaseCampaign(
    @Param('userId') userId: string, @Param('campaignId') campaignId: string,
    @Headers('x-internal-key') key: string,
  ) {
    this.verifyInternalKey(key);
    return { status: 'success', data: await this.campaignEscrow.change(userId, campaignId, 'release') };
  }


  @Public()
  @Post('wallets/:userId/campaign-escrows/:campaignId/status')
  @ApiOperation({ summary: 'Internal: Atomically change campaign status and reservation' })
  async campaignStatus(
    @Param('userId') userId: string, @Param('campaignId') campaignId: string,
    @Headers('x-internal-key') key: string, @Body() dto: CampaignStatusDto,
  ) {
    this.verifyInternalKey(key);
    const data = await this.campaignEscrow.change(userId, campaignId, dto.status === 'active' ? 'reserve' : 'release', undefined, dto.status);
    return { status: 'success', data };
  }

}
