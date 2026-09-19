import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ExchangeRateModule, ProvidersModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
