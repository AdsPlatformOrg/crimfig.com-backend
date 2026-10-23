import { Injectable, Inject, NotFoundException, BadRequestException, Logger, ServiceUnavailableException, Optional } from '@nestjs/common';
import { SubscriptionPaymentsService } from './subscription-payments.service';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingSubscriptions, billingSavedCards, billingTransactions } from '@crimfig/database/schema';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { PaystackService } from '../providers/paystack.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

import { APP_PLANS } from './subscription-catalog';
export { APP_PLANS, PlanDefinition } from './subscription-catalog';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystackService: PaystackService,
    private readonly fxService: ExchangeRateService,
    @Optional() private readonly payments?: SubscriptionPaymentsService,
  ) {}

  /**
   * Get all active and past subscriptions for a user
   */
  async getUserSubscriptions(userId: string) {
    const subs = await this.db
      .select({
        id: billingSubscriptions.id,
        appSlug: billingSubscriptions.appSlug,
        plan: billingSubscriptions.plan,
        priceUsdCents: billingSubscriptions.priceUsdCents,
        provider: billingSubscriptions.provider,
        status: billingSubscriptions.status,
        currentPeriodStart: billingSubscriptions.currentPeriodStart,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
        nextBillingDate: billingSubscriptions.nextBillingDate,
        cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
        savedCardId: billingSubscriptions.savedCardId,
        createdAt: billingSubscriptions.createdAt,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .orderBy(desc(billingSubscriptions.createdAt));

    return subs;
  }

  /**
   * Get catalog plans
   */
  getCatalog(appSlug?: string) {
    if (appSlug && APP_PLANS[appSlug]) {
      return APP_PLANS[appSlug];
    }
    return APP_PLANS;
  }

  /**
   * Subscribe to an app plan using saved card or direct payment
   */
  async subscribe(params: {
    userId: string;
    userEmail: string;
    appSlug: string;
    planId: string;
    interval: 'monthly' | 'annual';
    savedCardId?: string;
    requestId?: string;
  }) {
    if (!this.payments) throw new ServiceUnavailableException('This payment operation is unavailable pending its atomic reservation, provider reconciliation and completion contract');
    if (params.savedCardId) throw new ServiceUnavailableException('Saved-card subscription charging requires explicit recurring consent and its renewal contract');
    return this.payments.initialize({ userId: params.userId, requestId: params.requestId || '', appSlug: params.appSlug, planId: params.planId, interval: params.interval });
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription(userId: string, subscriptionId: string) {
    if (this.payments) return this.payments.cancel(userId, subscriptionId);
    // Single owner-bound conditional UPDATE: no read-then-write race, idempotent on repeat.
    // Cancel-at-period-end keeps the paid status until the period actually ends; it must not
    // flip to 'cancelled' (which would cut off access already paid for).
    const [updated] = await this.db
      .update(billingSubscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(and(
        eq(billingSubscriptions.id, subscriptionId),
        eq(billingSubscriptions.userId, userId),
        inArray(billingSubscriptions.status, ['active', 'trialing', 'past_due']),
      ))
      .returning();

    if (updated) {
      return { status: updated.status, cancelAtPeriodEnd: true, subscription: updated };
    }

    const [existing] = await this.db
      .select()
      .from(billingSubscriptions)
      .where(and(eq(billingSubscriptions.id, subscriptionId), eq(billingSubscriptions.userId, userId)))
      .limit(1);
    if (!existing) {
      throw new NotFoundException('Subscription not found');
    }
    // Already ended (cancelled/expired): nothing to change; report the real state.
    return { status: existing.status, cancelAtPeriodEnd: existing.cancelAtPeriodEnd, subscription: existing };
  }
}
