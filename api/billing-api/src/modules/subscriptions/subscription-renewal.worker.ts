import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, gt, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { SubscriptionPaymentsService } from './subscription-payments.service';

/** Bounded scans; durable per-generation claims coordinate multiple worker replicas. */
@Injectable()
export class SubscriptionRenewalWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionRenewalWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private pendingCursor?: string;
  private dueCursor?: string;
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>, private readonly payments: SubscriptionPaymentsService) {}
  onModuleInit() {
    if (process.env.BILLING_SUBSCRIPTION_RENEWALS_ENABLED !== 'true') return;
    this.timer = setInterval(() => { void this.run(); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Recovery remains necessary even if the owner cancelled after a dispatch claim committed.
      const pending = await this.db.select().from(schema.billingTransactions).where(and(
        eq(schema.billingTransactions.type, 'subscription_renewal'), eq(schema.billingTransactions.status, 'pending'),
        this.pendingCursor ? gt(schema.billingTransactions.id, this.pendingCursor) : undefined,
      )).orderBy(asc(schema.billingTransactions.id)).limit(50);
      this.pendingCursor = pending.length === 50 ? pending[pending.length - 1].id : undefined;
      for (const row of pending) {
        try { await this.payments.recoverReference(row.userId, row.reference!); }
        catch { this.logger.warn(`Renewal ${row.id} requires recovery`); }
      }
      const due = await this.db.select().from(schema.billingSubscriptions).where(and(
        eq(schema.billingSubscriptions.cancelAtPeriodEnd, false), lte(schema.billingSubscriptions.currentPeriodEnd, new Date()),
        this.dueCursor ? gt(schema.billingSubscriptions.id, this.dueCursor) : undefined,
      )).orderBy(asc(schema.billingSubscriptions.id)).limit(50);
      this.dueCursor = due.length === 50 ? due[due.length - 1].id : undefined;
      for (const sub of due) {
        try { await this.payments.renew(sub.id); }
        catch { this.logger.warn(`Subscription ${sub.id} requires renewal review`); }
      }
    } catch { this.logger.warn('Subscription renewal scan unavailable'); }
    finally { this.busy = false; }
  }
}
