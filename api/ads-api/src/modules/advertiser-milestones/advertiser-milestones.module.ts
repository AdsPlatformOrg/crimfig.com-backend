import { Module } from '@nestjs/common';
import { AdvertiserMilestonesController } from './advertiser-milestones.controller';
import { AdvertiserMilestonesService } from './advertiser-milestones.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [AdvertiserMilestonesController],
  providers: [AdvertiserMilestonesService],
  exports: [AdvertiserMilestonesService],
})
export class AdvertiserMilestonesModule {}
