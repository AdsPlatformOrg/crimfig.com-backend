import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './modules/database/database.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { PromotersModule } from './modules/promoters/promoters.module';
import { VerificationModule } from './modules/verification/verification.module';
import { PlacementsModule } from './modules/placements/placements.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    CampaignsModule,
    PromotersModule,
    VerificationModule,
    PlacementsModule,
    DeliveryModule,
    AnalyticsModule,
    HealthModule,
  ],
})
export class AppModule {}
