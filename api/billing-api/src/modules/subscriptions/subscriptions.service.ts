import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
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
    const appCatalog = APP_PLANS[params.appSlug] || [];
    const plan = appCatalog.find((p) => p.id === params.planId);
    if (!plan) {
      throw new BadRequestException(`Plan ${params.planId} not found for app ${params.appSlug}`);
    }

    const amountUsd = params.interval === 'annual' ? plan.annualUsd : plan.monthlyUsd;
    const usdCents = amountUsd * 100;
    const fx = await this.fxService.getUsdToNgnRate();
    const conversion = await this.fxService.convertUsdCentsToNgn(usdCents, fx.rate);

    const now = new Date();
    const periodEnd = new Date(now);
    if (params.interval === 'annual') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    // Check if user already has an active subscription for this app
    const [existing] = await this.db
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, params.userId),
          eq(billingSubscriptions.appSlug, params.appSlug),
          eq(billingSubscriptions.status, 'active'),
        ),
      )
      .limit(1);

    if (existing) {
      throw new BadRequestException(`You already have an active subscription for ${params.appSlug}`);
    }

    // If savedCardId provided, charge immediately via Paystack
    let savedCardToken = '';
    let usedCardId = params.savedCardId;
    if (params.savedCardId) {
      const [card] = await this.db
        .select()
        .from(billingSavedCards)
        .where(
          and(
            eq(billingSavedCards.id, params.savedCardId),
            eq(billingSavedCards.userId, params.userId),
          ),
        )
        .limit(1);

      if (!card) {
        throw new BadRequestException('Specified saved card not found');
      }
      savedCardToken = card.providerToken;
    } else {
      // Find default saved card if available
      const [defaultCard] = await this.db
        .select()
        .from(billingSavedCards)
        .where(
          and(
            eq(billingSavedCards.userId, params.userId),
            eq(billingSavedCards.isDefault, true),
          ),
        )
        .limit(1);

      if (defaultCard) {
        usedCardId = defaultCard.id;
        savedCardToken = defaultCard.providerToken;
      }
    }

    const reference = `crimfig_sub_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    if (savedCardToken) {
      const paystackRes = await this.paystackService.chargeAuthorization({
        email: params.userEmail,
        amountKobo: conversion.ngnKobo,
        authorizationCode: savedCardToken,
        metadata: {
          type: 'subscription',
          appSlug: params.appSlug,
          planId: params.planId,
          interval: params.interval,
        },
      });

      if (paystackRes.status === 'success') {
        const [sub] = await this.db
          .insert(billingSubscriptions)
          .values({
            userId: params.userId,
            appSlug: params.appSlug,
            plan: params.interval,
            priceUsdCents: usdCents,
            provider: 'paystack',
            status: 'active',
            savedCardId: usedCardId,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            nextBillingDate: periodEnd,
            cancelAtPeriodEnd: false,
          })
          .returning();

        await this.db.insert(billingTransactions).values({
          userId: params.userId,
          type: 'subscription_charge',
          status: 'completed',
          provider: 'paystack',
          reference,
          amountUsdCents: usdCents,
          amountNgnKobo: conversion.ngnKobo,
          exchangeRateId: fx.rateId,
          metadata: JSON.stringify({
            subscriptionId: sub.id,
            appSlug: params.appSlug,
            planName: plan.name,
            interval: params.interval,
          }),
        });

        return { status: 'active', subscription: sub, message: 'Subscription activated' };
      }
    }

    // Initiate Paystack checkout
    const initRes = await this.paystackService.initializeTransaction({
      email: params.userEmail,
      amountKobo: conversion.ngnKobo,
      metadata: {
        type: 'subscription',
        userId: params.userId,
        appSlug: params.appSlug,
        planId: params.planId,
        interval: params.interval,
        amountUsdCents: usdCents,
        saveCard: true,
      },
    });

    return {
      status: 'pending_payment',
      authorizationUrl: initRes.authorization_url,
      reference: initRes.reference,
      amountUsd,
      amountNgn: conversion.ngnAmount,
    };
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
