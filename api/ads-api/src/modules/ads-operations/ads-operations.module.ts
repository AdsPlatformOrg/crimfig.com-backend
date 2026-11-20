import { Module } from '@nestjs/common';
import { VerificationModule } from '../verification/verification.module';
import { DatabaseModule } from '../database/database.module';
import { AdsOperationsController } from './ads-operations.controller';
import { AdsOperationsService } from './ads-operations.service';

@Module({
  imports: [DatabaseModule, VerificationModule],
  controllers: [AdsOperationsController],
  providers: [AdsOperationsService],
})
export class AdsOperationsModule {}
