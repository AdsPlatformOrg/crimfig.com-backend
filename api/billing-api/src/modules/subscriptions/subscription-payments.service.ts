import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingSubscriptions as subscriptions, billingTransactions as transactions, billingSavedCards as cards, billingProviderEvents as events, users } from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaystackService } from '../providers/paystack.service';
import { matchesSubscriptionPayment, subscriptionEntitled, subscriptionPeriodEnd, subscriptionPrice } from './subscription-contract';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class SubscriptionPaymentsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly fx: ExchangeRateService, private readonly provider: PaystackService) {}

  private reference(userId: string, requestId: string) {
    if (typeof requestId !== 'string' || !uuid.test(requestId)) throw new BadRequestException('A UUID v4 subscription request ID is required');
    return 'cf-sub-' + createHash('sha256').update(`${userId.toLowerCase()}:${requestId.toLowerCase()}`).digest('hex');
  }
  private async lock(tx: any, userId: string, appSlug: string) {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`subscription:${userId}:${appSlug}`}, 0))`);
  }
  private metadata(row: any) {
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta.subscriptionVersion !== 2 || typeof meta.appSlug !== 'string' || !uuid.test(meta.subscriptionId)) throw Error();
      return meta;
    } catch { throw new ConflictException('Subscription intent requires reconciliation'); }
  }
  private view(row: any) {
    const meta = this.metadata(row);
    return { requestId: meta.requestId, reference: row.reference, status: row.status,
      subscriptionId: row.status === 'completed' ? meta.subscriptionId : null,
      amountUsdCents: row.amountUsdCents, amountNgnKobo: row.amountNgnKobo,
      checkoutUrl: row.status === 'pending' ? meta.checkoutUrl || null : null };
  }

  /** New-card checkout purchases one period. Recurring consent is never inferred from a payment. */
  async initialize(input: { userId: string; requestId: string; appSlug: string; planId: string; interval: 'monthly' | 'annual' }) {
    const reference = this.reference(input.userId, input.requestId);
    let price: ReturnType<typeof subscriptionPrice>;
    try { price = subscriptionPrice(input.appSlug, input.planId, input.interval); }
    catch { throw new BadRequestException('Unknown subscription plan or interval'); }
    const domain = this.provider.paymentDomain();
    const callback = new URL(process.env.BILLING_WEB_URL || (process.env.NODE_ENV === 'production' ? 'https://billing.crimfig.com/' : 'http://localhost:3007/'));
    if (callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/' ||
      !(callback.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname)))) {
      throw new ServiceUnavailableException('Subscription callback is not configured safely');
    }
    callback.searchParams.set('subscription_request', input.requestId.toLowerCase());
    const [prior] = await this.db.select().from(transactions).where(and(eq(transactions.reference, reference), eq(transactions.userId, input.userId)));
    const sameRequest = (row: any) => {
      const meta = this.metadata(row);
      if (row.type !== 'subscription_charge' || row.provider !== 'paystack' || meta.appSlug !== price.appSlug ||
        meta.planId !== price.planId || meta.interval !== price.interval || meta.domain !== domain) {
        throw new ConflictException('Subscription request ID is already bound to another purchase');
      }
      return this.view(row);
    };
    if (prior) return sameRequest(prior);
    const quote = await this.fx.getUsdToNgnRate();
    const conversion = await this.fx.convertUsdCentsToNgn(price.cents, quote);
    if (!quote.rateId || !Number.isSafeInteger(conversion.ngnKobo) || conversion.ngnKobo <= 0 || conversion.ngnKobo > 2147483647) {
      throw new ServiceUnavailableException('A persisted subscription FX quote is required');
    }
    const claim = await this.db.transaction(async tx => {
      await this.lock(tx, input.userId, price.appSlug);
      const [existing] = await tx.select().from(transactions).where(eq(transactions.reference, reference)).for('update');
      if (existing) { sameRequest(existing); return { created: false, row: existing }; }
      const [owner] = await tx.select({ id: users.id, email: users.email, status: users.status }).from(users).where(eq(users.id, input.userId)).for('share');
      if (!owner || owner.status !== 'ACTIVE') throw new ConflictException('Account is not active');
      const active = await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, input.userId), eq(subscriptions.appSlug, price.appSlug))).for('update');
      if (active.some(sub => sub.currentPeriodEnd > new Date() && ['active', 'trialing', 'past_due'].includes(sub.status))) {
        throw new ConflictException('An existing paid period must end before a new checkout');
      }
      const pending = await tx.select().from(transactions).where(and(eq(transactions.userId, input.userId),
        eq(transactions.type, 'subscription_charge'), eq(transactions.status, 'pending'))).for('update');
      if (pending.some(row => this.metadata(row).appSlug === price.appSlug)) throw new ConflictException('Recover the existing subscription payment before starting another');
      const [row] = await tx.insert(transactions).values({ userId: input.userId, type: 'subscription_charge', status: 'pending',
        provider: 'paystack', reference, amountUsdCents: price.cents, amountNgnKobo: conversion.ngnKobo, exchangeRateId: quote.rateId,
        metadata: JSON.stringify({ subscriptionVersion: 2, subscriptionId: randomUUID(), requestId: input.requestId.toLowerCase(),
          ...price, expectedEmail: owner.email.toLowerCase().trim(), domain, callbackUrl: callback.href, dispatch: 'started', autoRenew: false }),
      }).returning();
      return { created: true, row };
    });
    if (!claim.created) return this.view(claim.row);
    const meta = this.metadata(claim.row);
    // Claim commits before provider I/O. Ambiguous delivery never replays initialization.
    try {
      const result = await this.provider.initializeTransaction({ email: meta.expectedEmail, amountKobo: claim.row.amountNgnKobo!, reference,
        callbackUrl: callback.href, metadata: { userId: input.userId, transactionId: claim.row.id } });
      const checkout = new URL(result.authorization_url);
      if (result.reference !== reference || !result.access_code || checkout.origin !== 'https://checkout.paystack.com' || checkout.username || checkout.password || checkout.hash) throw Error();
      const saved = await this.db.transaction(async tx => {
        await this.lock(tx, input.userId, price.appSlug);
        const [current] = await tx.select().from(transactions).where(eq(transactions.id, claim.row.id)).for('update');
        const [updated] = await tx.update(transactions).set({ metadata: JSON.stringify({ ...this.metadata(current), checkoutUrl: checkout.href }), updatedAt: new Date() })
          .where(eq(transactions.id, current.id)).returning();
        return updated;
      });
      return this.view(saved);
    } catch { throw new ServiceUnavailableException({ message: 'Subscription checkout is unconfirmed; recover this request without another charge', reference, requestId: input.requestId }); }
  }

  /** Both verified callbacks and signed webhooks enter this same transaction boundary. */
  async complete(reference: string, data: any) {
    const [found] = await this.db.select().from(transactions).where(and(eq(transactions.reference, reference), eq(transactions.provider, 'paystack')));
    if (!found) throw new NotFoundException('Subscription payment not found');
    const initial = this.metadata(found);
    return this.db.transaction(async tx => {
      await this.lock(tx, found.userId, initial.appSlug);
      const [intent] = await tx.select().from(transactions).where(eq(transactions.id, found.id)).for('update');
      const meta = this.metadata(intent);
      if (!matchesSubscriptionPayment(intent, meta, data, this.provider.paymentDomain())) throw new ConflictException('Payment does not match its subscription intent');
      if (intent.status === 'completed') return this.view(intent);
      if (intent.status !== 'pending') throw new ConflictException('Subscription payment requires reconciliation');
      const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, intent.userId)).for('share');
      if (owner?.status !== 'ACTIVE') throw new ConflictException('Account requires reconciliation before activation');
      const others = await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, intent.userId), eq(subscriptions.appSlug, meta.appSlug))).for('update');
      const renewal = intent.type === 'subscription_renewal';
      const previous = others.find(sub => sub.id === meta.subscriptionId);
      if (renewal && (!previous || previous.lastPaymentReference !== meta.renewalBaseReference || previous.currentPeriodEnd.toISOString() !== meta.expectedPeriodEnd)) {
        throw new ConflictException('Renewal period changed; reconciliation required');
      }
      if (others.some(sub => sub.currentPeriodEnd > new Date() && ['active', 'trialing', 'past_due'].includes(sub.status))) throw new ConflictException('Overlapping subscription requires reconciliation');
      const start = new Date(), end = subscriptionPeriodEnd(start, meta.interval);
      const values = { id: meta.subscriptionId, userId: intent.userId, appSlug: meta.appSlug, plan: meta.interval,
        status: 'active', priceUsdCents: intent.amountUsdCents, provider: 'paystack', currentPeriodStart: start, currentPeriodEnd: end,
        nextBillingDate: end, cancelAtPeriodEnd: renewal ? previous!.cancelAtPeriodEnd : true,
        lastPaymentReference: reference, lastPaymentDate: start, failedRenewalAttempts: 0, updatedAt: start } as const;
      if (renewal) await tx.update(subscriptions).set(values).where(eq(subscriptions.id, previous!.id));
      else await tx.insert(subscriptions).values(values);
      const [completed] = await tx.update(transactions).set({ status: 'completed', idempotencyKey: `subscription:v2:${intent.id}`,
        metadata: JSON.stringify({ ...meta, completion: { periodStart: start.toISOString(), periodEnd: end.toISOString(), reference, domain: data.domain } }), updatedAt: start })
        .where(eq(transactions.id, intent.id)).returning();
      return this.view(completed);
    });
  }

  async recover(userId: string, requestId: string) {
    const reference = this.reference(userId, requestId);
    const [intent] = await this.db.select().from(transactions).where(and(eq(transactions.reference, reference), eq(transactions.userId, userId)));
    if (!intent) throw new NotFoundException('Subscription request not found');
    this.metadata(intent);
    if (intent.status === 'completed') return this.view(intent);
    let verified;
    try { verified = await this.provider.verifyTransaction(reference); } catch { return this.view(intent); }
    if (verified.status === 'success') return this.complete(reference, verified);
    return this.view(intent); // Failed/abandoned is not proof that a delayed charge cannot settle.
  }

  async recoverReference(userId: string, reference: string) {
    if (!/^cf-(sub|ren)-[a-f0-9]{64}$/.test(reference)) throw new BadRequestException('Invalid subscription reference');
    const [intent] = await this.db.select().from(transactions).where(and(eq(transactions.reference, reference), eq(transactions.userId, userId)));
    if (!intent) throw new NotFoundException('Subscription payment not found');
    this.metadata(intent);
    if (intent.status === 'completed') return this.view(intent);
    let data;
    try { data = await this.provider.verifyTransaction(reference); } catch { return this.view(intent); }
    return data.status === 'success' ? this.complete(reference, data) : this.view(intent);
  }

  async entitlement(userId: string, appSlug: string) {
    const rows = await this.db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.appSlug, appSlug)));
    for (const sub of rows) {
      if (!sub.lastPaymentReference) continue;
      const [receipt] = await this.db.select().from(transactions).where(eq(transactions.reference, sub.lastPaymentReference));
      if (subscriptionEntitled(sub, receipt)) return { entitled: true, subscriptionId: sub.id, planId: this.metadata(receipt).planId, expiresAt: sub.currentPeriodEnd };
    }
    return { entitled: false, subscriptionId: null, planId: null, expiresAt: null };
  }

  /** Explicit owner consent fixes the USD price and maximum NGN charge, including FX movement. */
  async preferences(userId: string, subscriptionId: string) {
    const [sub] = await this.db.select().from(subscriptions).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
    if (!sub) throw new NotFoundException('Subscription not found');
    const [receipt] = sub.lastPaymentReference ? await this.db.select().from(transactions).where(and(
      eq(transactions.reference, sub.lastPaymentReference), eq(transactions.userId, userId))) : [];
    const entitled = subscriptionEntitled(sub, receipt);
    const consent = entitled ? this.metadata(receipt).renewalConsent : undefined;
    return { subscriptionId: sub.id, appSlug: sub.appSlug, interval: sub.plan, amountUsdCents: sub.priceUsdCents,
      currentPeriodEnd: sub.currentPeriodEnd, entitled, autoRenew: !sub.cancelAtPeriodEnd,
      savedCardId: sub.savedCardId, maxNgnKobo: Number.isSafeInteger(consent?.maxNgnKobo) ? consent.maxNgnKobo : null,
      renewalProcessingAvailable: process.env.BILLING_SUBSCRIPTION_RENEWALS_ENABLED === 'true' };
  }

  async consent(userId: string, subscriptionId: string, input: { requestId: string; savedCardId: string; maxNgnKobo: number; expectedPeriodEnd: string }) {
    if (!uuid.test(input.requestId) || !Number.isSafeInteger(input.maxNgnKobo) || input.maxNgnKobo <= 0 || input.maxNgnKobo > 2147483647) {
      throw new BadRequestException('A consent request ID and bounded NGN charge limit are required');
    }
    const [found] = await this.db.select().from(subscriptions).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
    if (!found) throw new NotFoundException('Subscription not found');
    return this.db.transaction(async tx => {
      await this.lock(tx, userId, found.appSlug);
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
      if (sub.currentPeriodEnd.toISOString() !== input.expectedPeriodEnd) throw new ConflictException('Review the current subscription period');
      const [receipt] = await tx.select().from(transactions).where(eq(transactions.reference, sub.lastPaymentReference!)).for('update');
      if (!subscriptionEntitled(sub, receipt)) throw new ConflictException('A currently paid, verified subscription is required');
      const [card] = await tx.select().from(cards).where(and(eq(cards.id, input.savedCardId), eq(cards.userId, userId))).for('share');
      const meta = this.metadata(receipt);
      if (!card || card.provider !== 'paystack' || card.billingEmail?.toLowerCase().trim() !== meta.expectedEmail ||
        !/^AUTH_/.test(card.providerToken)) throw new ConflictException('A matching saved payment authorization is required');
      const consent = { id: input.requestId.toLowerCase(), savedCardId: card.id, maxNgnKobo: input.maxNgnKobo,
        amountUsdCents: sub.priceUsdCents, interval: sub.plan, expectedPeriodEnd: input.expectedPeriodEnd, acceptedAt: new Date().toISOString() };
      const reference = `internal.subscription.consent:${userId}:${consent.id}`;
      const [prior] = await tx.select().from(events).where(and(eq(events.provider, 'paystack'), eq(events.reference, reference)));
      if (prior) {
        const old = prior.rawPayload as any;
        if (old.subscriptionId !== sub.id || old.consent.savedCardId !== card.id || old.consent.maxNgnKobo !== input.maxNgnKobo || old.consent.expectedPeriodEnd !== input.expectedPeriodEnd) {
          throw new ConflictException('Consent request is already bound to different terms');
        }
        // A stale consent replay must never undo subsequent cancellation.
        return { autoRenew: !sub.cancelAtPeriodEnd, subscriptionId: sub.id };
      }
      await tx.insert(events).values({ provider: 'paystack', reference, eventType: 'internal.subscription.renewal_consent',
        rawPayload: { version: 2, userId, subscriptionId: sub.id, consent }, processed: true, processedAt: new Date() });
      await tx.update(transactions).set({ metadata: JSON.stringify({ ...meta, renewalConsent: consent }), updatedAt: new Date() }).where(eq(transactions.id, receipt.id));
      await tx.update(subscriptions).set({ savedCardId: card.id, cancelAtPeriodEnd: false, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
      return { autoRenew: true, subscriptionId: sub.id };
    });
  }

  async cancel(userId: string, subscriptionId: string) {
    const [found] = await this.db.select().from(subscriptions).where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
    if (!found) throw new NotFoundException('Subscription not found');
    return this.db.transaction(async tx => {
      await this.lock(tx, userId, found.appSlug);
      const [sub] = await tx.update(subscriptions).set({ cancelAtPeriodEnd: true, cancelledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId))).returning();
      return { status: sub.status, cancelAtPeriodEnd: true, subscription: sub };
    });
  }

  /** One durable charge attempt per paid generation. A timeout is recovered by GET, never resent. */
  async renew(subscriptionId: string) {
    const [found] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
    if (!found) throw new NotFoundException('Subscription not found');
    if (found.cancelAtPeriodEnd || found.currentPeriodEnd > new Date()) return { status: 'not_due' };
    const reference = 'cf-ren-' + createHash('sha256').update(`${found.id}:${found.lastPaymentReference}:${found.currentPeriodEnd.toISOString()}`).digest('hex');
    const [prior] = await this.db.select().from(transactions).where(eq(transactions.reference, reference));
    if (prior) {
      if (prior.status === 'completed') return this.view(prior);
      const data = await this.provider.verifyTransaction(reference);
      return data.status === 'success' ? this.complete(reference, data) : this.view(prior);
    }
    const quote = await this.fx.getUsdToNgnRate();
    const conversion = await this.fx.convertUsdCentsToNgn(found.priceUsdCents, quote);
    const domain = this.provider.paymentDomain();
    const claim = await this.db.transaction(async tx => {
      await this.lock(tx, found.userId, found.appSlug);
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).for('update');
      if (sub.cancelAtPeriodEnd || sub.currentPeriodEnd > new Date() || sub.lastPaymentReference !== found.lastPaymentReference) return null;
      const [existing] = await tx.select().from(transactions).where(eq(transactions.reference, reference));
      if (existing) return { row: existing, authorization: null };
      const [receipt] = await tx.select().from(transactions).where(eq(transactions.reference, sub.lastPaymentReference!));
      // Verify the paid generation at its final entitled millisecond, not at an expired wall clock.
      if (!subscriptionEntitled({ ...sub, status: 'active' }, receipt, new Date(sub.currentPeriodEnd.getTime() - 1))) throw new ConflictException('Unproven subscription generation');
      const meta = this.metadata(receipt), consent = meta.renewalConsent;
      const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, sub.userId)).for('share');
      if (owner?.status !== 'ACTIVE' || !consent || consent.savedCardId !== sub.savedCardId || consent.amountUsdCents !== sub.priceUsdCents ||
        consent.interval !== sub.plan || meta.domain !== domain || !quote.rateId || !Number.isSafeInteger(conversion.ngnKobo) ||
        conversion.ngnKobo <= 0 || conversion.ngnKobo > consent.maxNgnKobo) throw new ConflictException('Renewal requires current consent within the agreed charge limit');
      const [card] = await tx.select().from(cards).where(and(eq(cards.id, sub.savedCardId!), eq(cards.userId, sub.userId))).for('share');
      if (!card || card.provider !== 'paystack' || card.billingEmail?.toLowerCase().trim() !== meta.expectedEmail) throw new ConflictException('Renewal card unavailable');
      const [row] = await tx.insert(transactions).values({ userId: sub.userId, type: 'subscription_renewal', status: 'pending', provider: 'paystack', reference,
        amountUsdCents: sub.priceUsdCents, amountNgnKobo: conversion.ngnKobo, exchangeRateId: quote.rateId,
        metadata: JSON.stringify({ subscriptionVersion: 2, subscriptionId: sub.id, requestId: randomUUID(), appSlug: sub.appSlug,
          planId: meta.planId, interval: sub.plan, expectedEmail: meta.expectedEmail, domain, renewalConsent: consent,
          expectedPeriodEnd: sub.currentPeriodEnd.toISOString(), renewalBaseReference: sub.lastPaymentReference, dispatch: 'started' }) }).returning();
      await tx.update(subscriptions).set({ status: 'past_due', updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
      return { row, authorization: card.providerToken };
    });
    if (!claim) return { status: 'not_due' };
    if (!claim.authorization) return this.view(claim.row);
    const meta = this.metadata(claim.row);
    try {
      await this.provider.chargeAuthorization({ email: meta.expectedEmail, authorizationCode: claim.authorization, amountKobo: claim.row.amountNgnKobo!,
        reference, metadata: { userId: found.userId, transactionId: claim.row.id } });
      const data = await this.provider.verifyTransaction(reference);
      return data.status === 'success' ? this.complete(reference, data) : this.view(claim.row);
    } catch { throw new ServiceUnavailableException('Renewal is unconfirmed; recover its existing reference without resending'); }
  }
}
