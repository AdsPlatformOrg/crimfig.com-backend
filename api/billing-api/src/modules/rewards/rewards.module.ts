import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WalletModule } from '../wallet/wallet.module';
import { RewardsFundService } from './rewards-fund.service';
import { PointsEngineService } from './points-engine.service';
import { RedemptionService } from './redemption.service';
import { GrowthReferralService } from './growth-referral.service';
import { RewardsController } from './rewards.controller';

@Module({
  imports: [DatabaseModule, WalletModule],
  controllers: [RewardsController],
  providers: [
    RewardsFundService,
    PointsEngineService,
    RedemptionService,
    GrowthReferralService,
  ],
  exports: [
    RewardsFundService,
    PointsEngineService,
    RedemptionService,
    GrowthReferralService,
  ],
})
export class RewardsModule {}
