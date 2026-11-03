import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PromotersModule } from '../promoters/promoters.module';
import { PublisherInventoryController } from './publisher-inventory.controller';
import { PublisherSlotsService } from './publisher-slots.service';
import { SdkHandshakeController } from './sdk-handshake.controller';
import { SetupChecksService } from './setup-checks.service';

@Module({
  imports: [DatabaseModule, PromotersModule],
  controllers: [PublisherInventoryController, SdkHandshakeController],
  providers: [PublisherSlotsService, SetupChecksService],
  exports: [PublisherSlotsService, SetupChecksService],
})
export class PublisherInventoryModule {}
