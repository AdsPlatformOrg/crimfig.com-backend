import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './modules/database/database.module';
import { ExchangeRateModule } from './modules/exchange-rate/exchange-rate.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { CardsModule } from './modules/cards/cards.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { EcosystemModule } from './modules/ecosystem/ecosystem.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    ExchangeRateModule,
    ProvidersModule,
    WalletModule,
    CardsModule,
    SubscriptionsModule,
    BankAccountsModule,
    WithdrawalsModule,
    TransactionsModule,
    WebhooksModule,
    EcosystemModule,
    HealthModule,
  ],
})
export class AppModule {}
