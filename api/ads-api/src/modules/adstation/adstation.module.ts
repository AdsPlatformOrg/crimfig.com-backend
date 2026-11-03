import { PublisherInventoryModule } from '../publisher-inventory/publisher-inventory.module';
import { Module } from '@nestjs/common';
import { AdstationController } from './adstation.controller';
import { AdstationService } from './adstation.service';
import { DatabaseModule } from '../database/database.module';
import { PromotersModule } from '../promoters/promoters.module';

@Module({
  imports: [DatabaseModule, PromotersModule, PublisherInventoryModule],
  controllers: [AdstationController],
  providers: [AdstationService],
  exports: [AdstationService],
})
export class AdstationModule {}
