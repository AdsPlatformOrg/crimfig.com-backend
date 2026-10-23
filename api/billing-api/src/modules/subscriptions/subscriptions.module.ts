import { SubscriptionRenewalWorker } from './subscription-renewal.worker';
import { SubscriptionPaymentsService } from './subscription-payments.service';
import { Module } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController } from './subscriptions.controller';
import { ProvidersModule } from '../providers/providers.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [ProvidersModule, ExchangeRateModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionPaymentsService, SubscriptionRenewalWorker],
  exports: [SubscriptionsService, SubscriptionPaymentsService],
})
export class SubscriptionsModule {}
