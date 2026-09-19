import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingTransactions } from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get user transaction ledger with pagination and filters
   */
  async getUserTransactions(userId: string, filters?: { type?: string; status?: string; limit?: number; offset?: number }) {
    const limit = Math.min(filters?.limit || 20, 100);
    const offset = filters?.offset || 0;

    const conditions = [eq(billingTransactions.userId, userId)];
    if (filters?.type) {
      conditions.push(eq(billingTransactions.type, filters.type as any));
    }
    if (filters?.status) {
      conditions.push(eq(billingTransactions.status, filters.status as any));
    }

    const rows = await this.db
      .select({
        id: billingTransactions.id,
        type: billingTransactions.type,
        status: billingTransactions.status,
        provider: billingTransactions.provider,
        reference: billingTransactions.reference,
        amountUsdCents: billingTransactions.amountUsdCents,
        amountNgnKobo: billingTransactions.amountNgnKobo,
        exchangeRateId: billingTransactions.exchangeRateId,
        metadata: billingTransactions.metadata,
        failureReason: billingTransactions.failureReason,
        createdAt: billingTransactions.createdAt,
      })
      .from(billingTransactions)
      .where(and(...conditions))
      .orderBy(desc(billingTransactions.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(billingTransactions)
      .where(and(...conditions));

    return {
      items: rows.map((r) => {
        let meta: any = {};
        try {
          meta = r.metadata ? JSON.parse(r.metadata) : {};
        } catch {}

        return {
          ...r,
          description: meta.description || `${r.type.replace('_', ' ').toUpperCase()}`,
          parsedMetadata: meta,
          amountUsd: r.amountUsdCents / 100,
          amountNgn: r.amountNgnKobo ? r.amountNgnKobo / 100 : null,
        };
      }),
      total: Number(countResult?.count || 0),
      limit,
      offset,
    };
  }

  /**
   * Get single transaction details
   */
  async getTransactionById(userId: string, transactionId: string) {
    const [tx] = await this.db
      .select()
      .from(billingTransactions)
      .where(and(eq(billingTransactions.id, transactionId), eq(billingTransactions.userId, userId)))
      .limit(1);

    if (!tx) {
      throw new NotFoundException('Transaction not found');
    }

    let meta: any = {};
    try {
      meta = tx.metadata ? JSON.parse(tx.metadata) : {};
    } catch {}

    return {
      ...tx,
      description: meta.description || `${tx.type.replace('_', ' ').toUpperCase()}`,
      parsedMetadata: meta,
      amountUsd: tx.amountUsdCents / 100,
      amountNgn: tx.amountNgnKobo ? tx.amountNgnKobo / 100 : null,
    };
  }
}
