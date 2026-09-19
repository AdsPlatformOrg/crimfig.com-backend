import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [EcosystemController],
})
export class EcosystemModule {}
