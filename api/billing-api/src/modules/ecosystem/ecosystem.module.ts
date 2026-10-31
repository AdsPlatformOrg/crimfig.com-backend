import { Module } from '@nestjs/common';
import { EcosystemController } from './ecosystem.controller';
import { CampaignEscrowService } from './campaign-escrow.service';
import { WalletModule } from '../wallet/wallet.module';
import { AdClearanceService } from './ad-clearance.service';
import { AdClearanceController } from './ad-clearance.controller';
import { AdSettlementService } from './ad-settlement.service';
import { AdRejectionService } from './ad-rejection.service';
import { AdRejectionController } from './ad-rejection.controller';
import { BillingStaffGrants } from '../security/billing-staff-grants';
import {AdOpportunityService} from './ad-opportunity.service';
import {AdOpportunityController} from './ad-opportunity.controller';
import {AdOpportunityWorker} from './ad-opportunity.worker';
import { FinancialPolicyController } from '../security/financial-policy.controller';

@Module({
  imports: [WalletModule],
  controllers: [EcosystemController, AdClearanceController, AdRejectionController,AdOpportunityController, FinancialPolicyController],
  providers: [
    CampaignEscrowService,
    AdOpportunityService,
    AdOpportunityWorker,
    AdClearanceService,
    AdSettlementService,
    AdRejectionService,
    BillingStaffGrants,
  ],
  exports: [BillingStaffGrants],
})
export class EcosystemModule {}

