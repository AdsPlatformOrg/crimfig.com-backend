import { Injectable, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsSettlementBatches, adsPromoterSettlementItems } from '@crimfig/database/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { BillingEcosystemClient } from './billing-ecosystem.client';

@Injectable()
export class AdsSettlementService {
  private readonly logger = new Logger(AdsSettlementService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly billingClient: BillingEcosystemClient,
  ) {}

  /** Unavailable: the legacy engine assigned unrelated promoters and credited before clearance.
   * History remains readable. Do not restore until funded, attributed event claims are durable.
   */
  async processPendingSettlement(options?: { forcePeriodStart?: Date; forcePeriodEnd?: Date }) {
    throw new ServiceUnavailableException('Settlement is unavailable until verified attribution, durable event claims and funded clearance reconciliation are implemented');
  }

  /**
   * Get historical settlement batches
   */
  async getHistoricalBatches(page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const [batches, countRes] = await Promise.all([
      this.db
        .select()
        .from(adsSettlementBatches)
        .orderBy(desc(adsSettlementBatches.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)` }).from(adsSettlementBatches),
    ]);

    const total = Number(countRes[0]?.count || 0);

    return {
      batches: batches.map((b) => ({
        ...b,
        totalDebitedUsd: b.totalDebitedUsdCents / 100,
        totalCreditedUsd: b.totalCreditedUsdCents / 100,
        totalCommissionPaidUsd: b.totalCommissionPaidUsdCents / 100,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get settlement batch details with line items
   */
  async getSettlementBatchDetails(batchId: string) {
    const [batch] = await this.db
      .select()
      .from(adsSettlementBatches)
      .where(eq(adsSettlementBatches.id, batchId))
      .limit(1);

    if (!batch) return null;

    const items = await this.db
      .select()
      .from(adsPromoterSettlementItems)
      .where(eq(adsPromoterSettlementItems.batchId, batchId));

    return {
      ...batch,
      totalDebitedUsd: batch.totalDebitedUsdCents / 100,
      totalCreditedUsd: batch.totalCreditedUsdCents / 100,
      totalCommissionPaidUsd: batch.totalCommissionPaidUsdCents / 100,
      items: items.map((i) => ({
        ...i,
        earnedUsd: i.earnedUsdCents / 100,
        billedUsd: i.billedUsdCents / 100,
      })),
    };
  }
}
