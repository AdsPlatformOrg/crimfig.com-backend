import { Module } from '@nestjs/common';
import { PlacementsService } from './placements.service';
import { PlacementsController } from './placements.controller';
import { PromotersModule } from '../promoters/promoters.module';

@Module({
  imports: [PromotersModule],
  controllers: [PlacementsController],
  providers: [PlacementsService],
  exports: [PlacementsService],
})
export class PlacementsModule {}
