import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { CampaignEscrowService } from './campaign-escrow.service';
import { WalletModule } from '../wallet/wallet.module';
import { AdClearanceService } from './ad-clearance.service';
import { AdClearanceController } from './ad-clearance.controller';
import { AdSettlementService } from './ad-settlement.service';

@Module({
  imports: [WalletModule],
  controllers: [EcosystemController, AdClearanceController],
  providers: [CampaignEscrowService, AdClearanceService, AdSettlementService],
})
export class EcosystemModule {}
