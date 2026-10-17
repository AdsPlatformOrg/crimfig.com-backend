import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { ImpressionTokenService } from './impression-token.service';
import { AuctionEngineService } from './auction-engine.service';
import { VerificationModule } from '../verification/verification.module';

@Module({
  imports: [VerificationModule],
  controllers: [DeliveryController],
  providers: [DeliveryService, ImpressionTokenService, AuctionEngineService],
  exports: [DeliveryService, ImpressionTokenService, AuctionEngineService],
})
export class DeliveryModule {}
