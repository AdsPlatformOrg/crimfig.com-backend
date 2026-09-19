import { Module } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WalletModule } from '../wallet/wallet.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [WalletModule, ExchangeRateModule, ProvidersModule],
  controllers: [WithdrawalsController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
