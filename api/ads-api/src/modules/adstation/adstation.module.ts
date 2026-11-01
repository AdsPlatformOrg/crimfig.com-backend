import { Module } from '@nestjs/common';
import { AdstationController } from './adstation.controller';
import { AdstationService } from './adstation.service';
import { SetupChecksService } from './setup-checks.service';
import { SdkHandshakeController } from './sdk-handshake.controller';
import { DatabaseModule } from '../database/database.module';
import { PromotersModule } from '../promoters/promoters.module';

@Module({
  imports: [DatabaseModule, PromotersModule],
  controllers: [AdstationController, SdkHandshakeController],
  providers: [AdstationService, SetupChecksService],
  exports: [AdstationService, SetupChecksService],
})
export class AdstationModule {}
