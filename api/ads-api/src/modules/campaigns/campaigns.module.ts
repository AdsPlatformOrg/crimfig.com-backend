import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { BillingModule } from '../billing/billing.module';
import { LocationsModule } from '../locations/locations.module';
import {CampaignRetentionController} from './campaign-retention.controller';
import {CampaignRetentionWorker} from './campaign-retention.worker';

@Module({
  imports: [BillingModule, LocationsModule],
  controllers: [CampaignsController,CampaignRetentionController],
  providers: [CampaignsService,CampaignRetentionWorker],
  exports: [CampaignsService],
})
export class CampaignsModule {}

