import { RefundReviewService } from './refund-review.service';
import { WithdrawalLedgerService } from './withdrawal-ledger.service';
import { WithdrawalDispatchService } from './withdrawal-dispatch.service';
import { Module } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WalletModule } from '../wallet/wallet.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [WalletModule, ExchangeRateModule, ProvidersModule],
  controllers: [WithdrawalsController],
  providers: [RefundReviewService, WithdrawalsService, WithdrawalLedgerService, WithdrawalDispatchService],
  exports: [WithdrawalsService, WithdrawalLedgerService, WithdrawalDispatchService],
})
export class WithdrawalsModule {}
