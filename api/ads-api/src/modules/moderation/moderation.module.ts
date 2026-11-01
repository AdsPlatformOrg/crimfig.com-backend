import { Module } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { AdsStaffGrants } from '../security/ads-staff-grants';

@Module({
  controllers: [ModerationController],
  providers: [ModerationService, AdsStaffGrants],
  exports: [ModerationService],
})
export class ModerationModule {}
