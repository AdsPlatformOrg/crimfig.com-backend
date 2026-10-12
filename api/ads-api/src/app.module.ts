import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './modules/database/database.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { PromotersModule } from './modules/promoters/promoters.module';
import { VerificationModule } from './modules/verification/verification.module';
import { PlacementsModule } from './modules/placements/placements.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
import { BillingModule } from './modules/billing/billing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    CampaignsModule,
    PromotersModule,
    VerificationModule,
    PlacementsModule,
    DeliveryModule,
    AnalyticsModule,
    HealthModule,
    BillingModule,
  ],
})
export class AppModule {}
