import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { CampaignEscrowService } from './campaign-escrow.service';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [EcosystemController],
  providers: [CampaignEscrowService],
})
export class EcosystemModule {}
