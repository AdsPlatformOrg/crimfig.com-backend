import { Global, Module } from '@nestjs/common';
import { AdvertiserMilestonesController } from './advertiser-milestones.controller';
import { AdvertiserMilestonesService } from './advertiser-milestones.service';
import { AdminRewardsControlsController } from './admin-rewards-controls.controller';
import { ProgramControlsService } from './program-controls.service';
import { DatabaseModule } from '../database/database.module';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [AdvertiserMilestonesController, AdminRewardsControlsController],
  providers: [AdvertiserMilestonesService, ProgramControlsService],
  exports: [AdvertiserMilestonesService, ProgramControlsService],
})
export class AdvertiserMilestonesModule {}
