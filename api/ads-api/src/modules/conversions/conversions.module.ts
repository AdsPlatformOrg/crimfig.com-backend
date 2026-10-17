import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConversionsService } from './conversions.service';
import { ConversionsController } from './conversions.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ConversionsController],
  providers: [ConversionsService],
  exports: [ConversionsService],
})
export class ConversionsModule {}
