import { Injectable, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsDeepAuditRuns, adsSettlementRebates, adsPromoterPenalties } from '@crimfig/database/schema';
import { eq, sql } from 'drizzle-orm';
import { BillingEcosystemClient } from './billing-ecosystem.client';

export interface DeepAuditOptions {
  lookbackHours?: number;
  auditLevel?: 'tier2_6h' | 'tier3_15d' | 'tier3_30d' | 'manual';
  dryRun?: boolean;
}

@Injectable()
export class DeferredAuditService {
  private readonly logger = new Logger(DeferredAuditService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly billingClient: BillingEcosystemClient,
  ) {}

  /** Clearance unavailable: legacy items may already have been credited; reconcile before any graduation. */
  async graduateClearedEarnings() {
    throw new ServiceUnavailableException('Clearance is unavailable until legacy credits and funded settlement items are reconciled');
  }

  /** Financial audit unavailable: rebates must reference actual settled events, campaigns and charged amounts. */
  async runTier2DeepMacroAudit(options?: DeepAuditOptions) {
    throw new ServiceUnavailableException('Financial fraud audit is unavailable until rebates are bound to actual settled events and amounts');
  }

  /** Extended financial audit unavailable: simulated penalties must never affect accounts. */
  async runTier3ExtendedAudit(level: 'tier3_15d' | 'tier3_30d') {
    throw new ServiceUnavailableException('Extended financial audit is unavailable; simulated penalties are disabled');
  }

  /**
   * Query recent deep audit runs
   */
  async getAuditRuns(limit = 20) {
    return this.db
      .select()
      .from(adsDeepAuditRuns)
      .orderBy(sql`${adsDeepAuditRuns.startedAt} DESC`)
      .limit(limit);
  }

  /**
   * Query rebates
   */
  async getRebates(campaignId?: string) {
    if (campaignId) {
      return this.db
        .select()
        .from(adsSettlementRebates)
        .where(eq(adsSettlementRebates.campaignId, campaignId));
    }
    return this.db.select().from(adsSettlementRebates).limit(50);
  }

  /**
   * Query outstanding penalties
   */
  async getPromoterPenalties(promoterId?: string) {
    if (promoterId) {
      return this.db
        .select()
        .from(adsPromoterPenalties)
        .where(eq(adsPromoterPenalties.promoterId, promoterId));
    }
    return this.db.select().from(adsPromoterPenalties).limit(50);
  }
}
