import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { UploadsService } from './uploads.service';
import { UploadsController } from './uploads.controller';
import { FirebaseStorageService } from './firebase-storage.service';
import { CloudflareR2StorageService } from './cloudflare-r2-storage.service';
import { MediaStorageRouter } from './media-storage-router.service';

@Module({
  imports: [DatabaseModule],
  controllers: [UploadsController],
  providers: [
    UploadsService,
    FirebaseStorageService,
    CloudflareR2StorageService,
    MediaStorageRouter,
  ],
  exports: [
    UploadsService,
    FirebaseStorageService,
    CloudflareR2StorageService,
    MediaStorageRouter,
  ],
})
export class UploadsModule {}
