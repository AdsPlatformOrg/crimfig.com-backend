import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { FirebaseStorageService } from './firebase-storage.service';

@Module({
  imports: [DatabaseModule],
  controllers: [UploadsController],
  providers: [UploadsService, FirebaseStorageService],
  exports: [UploadsService, FirebaseStorageService],
})
export class UploadsModule {}
