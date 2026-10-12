import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { DeferredAuditService } from './deferred-audit.service';
import { VerificationController } from './verification.controller';
import { PromotersModule } from '../promoters/promoters.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [PromotersModule, BillingModule],
  controllers: [VerificationController],
  providers: [VerificationService, DeferredAuditService],
  exports: [VerificationService, DeferredAuditService],
})
export class VerificationModule {}

