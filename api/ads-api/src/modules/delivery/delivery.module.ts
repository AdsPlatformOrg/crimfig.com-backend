import { AdminPerformanceController } from './admin-performance.controller';
import { EvidenceService } from './evidence.service';
import { EvidenceController } from './evidence.controller';
import { BillingModule } from '../billing/billing.module';
import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { AdminHouseAdsController } from './admin-house-ads.controller';
import { ImpressionTokenService } from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { VerificationModule } from '../verification/verification.module';

@Module({
  imports: [VerificationModule, BillingModule],
  controllers: [AdminPerformanceController, DeliveryController, EvidenceController, AdminHouseAdsController],
  providers: [EvidenceService, DeliveryService, ImpressionTokenService, AuctionEngineService],
  exports: [DeliveryService, ImpressionTokenService, AuctionEngineService],
})
export class DeliveryModule {}
