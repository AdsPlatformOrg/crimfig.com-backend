import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';

@Module({
  controllers: [EcosystemController],
})
export class EcosystemModule {}
