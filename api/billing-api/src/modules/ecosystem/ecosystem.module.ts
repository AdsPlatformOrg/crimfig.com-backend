import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { CampaignEscrowService } from './campaign-escrow.service';
import { WalletModule } from '../wallet/wallet.module';
import { AdClearanceService } from './ad-clearance.service';
import { AdClearanceController } from './ad-clearance.controller';
import { AdSettlementService } from './ad-settlement.service';
import { AdRejectionService } from './ad-rejection.service';
import { AdRejectionController } from './ad-rejection.controller';

@Module({
  imports: [WalletModule],
  controllers: [EcosystemController, AdClearanceController, AdRejectionController],
  providers: [CampaignEscrowService, AdClearanceService, AdSettlementService, AdRejectionService],
})
export class EcosystemModule {}
