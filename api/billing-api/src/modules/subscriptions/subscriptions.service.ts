import { Injectable, Inject, NotFoundException, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingSubscriptions, billingSavedCards, billingTransactions } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';
import { PaystackService } from '../providers/paystack.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

export interface PlanDefinition {
  id: string;
  name: string;
  appSlug: string;
  monthlyUsd: number;
  annualUsd: number;
  features: string[];
}

export const APP_PLANS: Record<string, PlanDefinition[]> = {
  chat: [
    { id: 'chat_pro', name: 'Chat Pro', appSlug: 'chat', monthlyUsd: 5, annualUsd: 50, features: ['Unlimited storage', 'HD video calls', 'Custom themes'] },
    { id: 'chat_business', name: 'Chat Enterprise', appSlug: 'chat', monthlyUsd: 15, annualUsd: 150, features: ['Admin compliance', 'Data export', 'Dedicated support'] },
  ],
  stream: [
    { id: 'stream_creator', name: 'Stream Creator', appSlug: 'stream', monthlyUsd: 12, annualUsd: 120, features: ['1080p60 streaming', 'Custom RTMP', 'VOD archiving'] },
  ],
  reels: [
    { id: 'reels_pro', name: 'Reels Creator+', appSlug: 'reels', monthlyUsd: 8, annualUsd: 80, features: ['Priority algorithm boost', 'Exclusive badges', 'Creator analytics'] },
  ],
  ads: [
    { id: 'ads_starter', name: 'Advertiser Pro', appSlug: 'ads', monthlyUsd: 20, annualUsd: 200, features: ['Advanced demographic targeting', 'Conversion API', 'Dedicated account manager'] },
  ],
};

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystackService: PaystackService,
    private readonly fxService: ExchangeRateService,
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
  }) {
    throw new ServiceUnavailableException('This payment operation is unavailable pending its atomic reservation, provider reconciliation and completion contract');
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription(userId: string, subscriptionId: string) {
    const [sub] = await this.db
      .select()
      .from(billingSubscriptions)
      .where(and(eq(billingSubscriptions.id, subscriptionId), eq(billingSubscriptions.userId, userId)))
      .limit(1);

    if (!sub) {
      throw new NotFoundException('Subscription not found');
    }

    const [updated] = await this.db
      .update(billingSubscriptions)
      .set({
        cancelAtPeriodEnd: true,
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(billingSubscriptions.id, subscriptionId))
      .returning();

    return { status: 'cancelled', subscription: updated };
  }
}
