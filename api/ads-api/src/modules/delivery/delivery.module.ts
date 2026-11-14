import {AdsStaffGrants} from '../security/ads-staff-grants';
import {CfigWorker} from '../cfig/cfig.worker';
import {CfigService} from '../cfig/cfig.service';
import {PromoterCfigController,AdminCfigController} from '../cfig/cfig.controller';
import { AdminPerformanceController } from './admin-performance.controller';
import { EvidenceService } from './evidence.service';
import { EvidenceController } from './evidence.controller';
import { BillingModule } from '../billing/billing.module';
import { DashboardAuthModule } from '@crimfig/shared';
import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { AdminHouseAdsController } from './admin-house-ads.controller';
import { TrafficQualityController } from './traffic-quality.controller';
import { ImpressionTokenService } from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { VerificationModule } from '../verification/verification.module';

@Module({
  imports: [DashboardAuthModule, VerificationModule, BillingModule],
  controllers: [PromoterCfigController, AdminCfigController, AdminPerformanceController, DeliveryController, EvidenceController, AdminHouseAdsController, TrafficQualityController],
  providers: [AdsStaffGrants, CfigWorker, CfigService, EvidenceService, DeliveryService, ImpressionTokenService, AuctionEngineService],
  exports: [DeliveryService, ImpressionTokenService, AuctionEngineService],
})
export class DeliveryModule {}
