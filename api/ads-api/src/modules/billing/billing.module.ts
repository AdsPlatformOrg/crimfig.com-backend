import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BillingEcosystemClient } from './billing-ecosystem.client';
import { AdsEscrowService } from './ads-escrow.service';
import { AdsSettlementService } from './ads-settlement.service';
import { AdsBillingController } from './ads-billing.controller';
import { DeferredAuditService } from './deferred-audit.service';
import {OpportunityClient} from './opportunity-client';

@Module({
  imports: [DatabaseModule],
  controllers: [AdsBillingController],
  providers: [BillingEcosystemClient, AdsEscrowService, AdsSettlementService, DeferredAuditService,OpportunityClient],
  exports: [BillingEcosystemClient, AdsEscrowService, AdsSettlementService, DeferredAuditService,OpportunityClient],
})
export class BillingModule {}
