import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BillingEcosystemClient } from './billing-ecosystem.client';
import { AdsEscrowService } from './ads-escrow.service';
import { AdsSettlementService } from './ads-settlement.service';
import { AdsBillingController } from './ads-billing.controller';
import { DeferredAuditService } from './deferred-audit.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AdsBillingController],
  providers: [BillingEcosystemClient, AdsEscrowService, AdsSettlementService, DeferredAuditService],
  exports: [BillingEcosystemClient, AdsEscrowService, AdsSettlementService, DeferredAuditService],
})
export class BillingModule {}
