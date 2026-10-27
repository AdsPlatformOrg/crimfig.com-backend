import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { BillingModule } from '../billing/billing.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [BillingModule, LocationsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}

