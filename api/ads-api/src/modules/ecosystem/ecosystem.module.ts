import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { AdsStaffGrants } from '../security/ads-staff-grants';

@Module({
  controllers: [EcosystemController],
  providers: [AdsStaffGrants],
})
export class EcosystemModule {}
