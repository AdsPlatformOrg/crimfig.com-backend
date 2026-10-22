import { Injectable, Inject, NotFoundException, BadRequestException, UnauthorizedException, Logger, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingWallets, billingTransactions, billingSavedCards } from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { createHash } from 'crypto';
import { PaystackService } from '../providers/paystack.service';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly fxService: ExchangeRateService,
    private readonly paystackService: PaystackService,
  ) {}

  /**
   * Get or automatically initialize a user's wallet
   */
  async getOrCreateWallet(userId: string) {
    const [existing] = await this.db
      .select()
      .from(billingWallets)
      .where(eq(billingWallets.userId, userId))
      .limit(1);

    if (existing) {
      return existing;
    }

    const [created] = await this.db
      .insert(billingWallets)
      .values({
        userId,
        balanceUsdCents: 0,
        lockedUsdCents: 0,
      })
      .onConflictDoNothing({ target: billingWallets.userId })
      .returning();

    if (created) return created;
    const [concurrent] = await this.db.select().from(billingWallets).where(eq(billingWallets.userId, userId)).limit(1);
    if (!concurrent) throw new ServiceUnavailableException('Wallet initialization could not be confirmed');
    return concurrent;
  }

  /**
   * Get wallet balance overview with USD and current NGN equivalent
   */
  async getBalance(userId: string) {
    const wallet = await this.getOrCreateWallet(userId);
    const fx = await this.fxService.getUsdToNgnRate();

    const availableUsdCents = wallet.balanceUsdCents;
    const lockedUsdCents = wallet.lockedUsdCents;
    const totalUsdCents = availableUsdCents + lockedUsdCents;

    const availableNgn = await this.fxService.convertUsdCentsToNgn(availableUsdCents, fx);
    const totalNgn = await this.fxService.convertUsdCentsToNgn(totalUsdCents, fx);

    return {
      userId,
      usd: {
        availableCents: availableUsdCents,
        availableAmount: availableUsdCents / 100,
        lockedCents: lockedUsdCents,
        lockedAmount: lockedUsdCents / 100,
        totalCents: totalUsdCents,
        totalAmount: totalUsdCents / 100,
      },
      ngnEquivalent: {
        availableKobo: availableNgn.ngnKobo,
        availableAmount: availableNgn.ngnAmount,
        totalKobo: totalNgn.ngnKobo,
        totalAmount: totalNgn.ngnAmount,
        exchangeRate: fx.rate,
        rateSource: fx.source,
      },
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Initialize a wallet funding session
   */
  async initializeFunding(params: {
    userId: string;
    userEmail: string;
    amountUsd: number;
    requestId: string;
    saveCard?: boolean;
    savedCardId?: string;
    callbackUrl?: string;
  }) {
    const usdCents = Math.round(params.amountUsd * 100);
    if (!Number.isFinite(params.amountUsd) || !Number.isSafeInteger(usdCents) || usdCents < 100 || usdCents > 2147483647 ||
        Math.abs(params.amountUsd * 100 - usdCents) > 0.000001) {
      throw new BadRequestException('Funding requires whole USD cents between 100 and 2147483647');
    }
    const reference = this.fundingRequestReference(params.userId, params.requestId);
    if (params.savedCardId) throw new ServiceUnavailableException('Saved-card charging is unavailable pending its durable operation contract');
    this.paystackService.paymentDomain(); // Fail before storing intent when key/mode is invalid.
    const callback = new URL(process.env.BILLING_WEB_URL || (process.env.NODE_ENV === 'production' ? 'https://billing.crimfig.com/' : 'http://localhost:3007/'));
    if (callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/' ||
        !(callback.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname)))) {
      throw new ServiceUnavailableException('Billing funding return URL is not configured safely');
    }
    if (params.callbackUrl && params.callbackUrl !== callback.href) throw new BadRequestException('Funding must return to the configured Billing page');
    const expectedEmail = params.userEmail.toLowerCase().trim();
    const binding = { amountUsdCents: usdCents, saveCard: params.saveCard === true, callbackUrl: callback.href, expectedEmail, domain: this.paystackService.paymentDomain() };
    const existing = await this.readFundingRequest(params.userId, params.requestId);
    if (existing) return this.fundingRequestView(existing, binding);
    const fx = await this.fxService.getUsdToNgnRate();
    const conversion = await this.fxService.convertUsdCentsToNgn(usdCents, fx);
    if (!fx.rateId || !Number.isFinite(fx.rate) || fx.rate <= 0 || !Number.isSafeInteger(conversion.ngnKobo) ||
        conversion.ngnKobo <= 0 || conversion.ngnKobo > 2147483647) throw new ServiceUnavailableException('A valid persisted funding quote is required');
    const claim = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`funding-request:${reference}`}, 0))`);
      const [prior] = await tx.select().from(billingTransactions).where(eq(billingTransactions.reference, reference)).for('update');
      if (prior) {
        if (prior.userId !== params.userId || prior.type !== 'wallet_fund' || prior.provider !== 'paystack') throw new ConflictException('Funding request requires reconciliation');
        this.fundingRequestView(prior, binding); return { intent: prior, created: false }; }
      const [intent] = await tx.insert(billingTransactions).values({
        userId: params.userId, type: 'wallet_fund', status: 'pending', provider: 'paystack', reference,
        amountUsdCents: usdCents, amountNgnKobo: conversion.ngnKobo, exchangeRateId: fx.rateId,
        metadata: JSON.stringify({ fundingVersion: 2, expectedEmail, saveCard: binding.saveCard,
          fundingRequestId: params.requestId.toLowerCase(), initialization: { state: 'started', ...binding },
          description: `Fund Wallet $${(usdCents / 100).toFixed(2)} USD` }),
      }).returning();
      return { intent, created: true };
    }, { isolationLevel: 'read committed' });
    if (!claim.created) return this.fundingRequestView(claim.intent, binding);
    // Only the transaction that created the durable claim may call initialize. No replay/lease expiry.
    try {
      const session = await this.paystackService.initializeTransaction({
        email: params.userEmail, amountKobo: conversion.ngnKobo, reference, callbackUrl: callback.href,
        metadata: { transactionId: claim.intent.id, userId: params.userId, usdCents },
      });
      const checkout = new URL(session.authorization_url);
      if (session.reference !== reference || !session.access_code || checkout.origin !== 'https://checkout.paystack.com' ||
          checkout.username || checkout.password || checkout.hash) throw new Error('Invalid checkout acknowledgement');
      const recorded = await this.db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '8s'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-fund:${claim.intent.id}`}, 0))`);
        const [current] = await tx.select().from(billingTransactions).where(eq(billingTransactions.id, claim.intent.id)).for('update');
        if (!current) throw new ConflictException('Funding intent requires reconciliation');
        const metadata = JSON.parse(current.metadata || '{}');
        await tx.update(billingTransactions).set({ metadata: JSON.stringify({ ...metadata,
          initialization: { ...metadata.initialization, state: 'ready', checkoutUrl: checkout.href } }), updatedAt: new Date() })
          .where(eq(billingTransactions.id, current.id));
        return { ...current, metadata: JSON.stringify({ ...metadata, initialization: { ...metadata.initialization, state: 'ready', checkoutUrl: checkout.href } }) };
      }, { isolationLevel: 'read committed' });
      return this.fundingRequestView(recorded, binding);
    } catch {
      throw new ServiceUnavailableException({ message: 'Funding initialization could not be confirmed; recover this request before starting another payment',
        requestId: params.requestId.toLowerCase(), reference, transactionId: claim.intent.id });
    }
  }

  private fundingRequestReference(userId: string, requestId: string) {
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      throw new BadRequestException('A UUID v4 funding request ID is required');
    }
    return `crimfig-fund-${createHash('sha256').update(`${userId.toLowerCase()}:${requestId.toLowerCase()}`).digest('hex')}`;
  }

  private async readFundingRequest(userId: string, requestId: string) {
    const reference = this.fundingRequestReference(userId, requestId);
    const [intent] = await this.db.select().from(billingTransactions)
      .where(and(eq(billingTransactions.reference, reference), eq(billingTransactions.userId, userId),
        eq(billingTransactions.type, 'wallet_fund'), eq(billingTransactions.provider, 'paystack'))).limit(1);
    if (intent) {
      let metadata: any;
      try { metadata = JSON.parse(intent.metadata || '{}'); } catch { throw new ConflictException('Funding request requires reconciliation'); }
      if (metadata?.fundingRequestId !== requestId.toLowerCase()) throw new ConflictException('Funding request identity requires reconciliation');
    }
    return intent;
  }

  private fundingRequestView(intent: typeof billingTransactions.$inferSelect, binding?: Record<string, unknown>) {
    let metadata: any;
    try { metadata = JSON.parse(intent.metadata || '{}'); } catch { throw new ConflictException('Funding request requires reconciliation'); }
    const initialization = metadata.initialization;
    if (metadata.fundingVersion !== 2 || !metadata.fundingRequestId ||
        intent.reference !== this.fundingRequestReference(intent.userId, metadata.fundingRequestId) ||
        !Number.isSafeInteger(intent.amountUsdCents) || intent.amountUsdCents < 100 || intent.amountUsdCents > 2147483647 ||
        initialization?.amountUsdCents !== intent.amountUsdCents || !Number.isSafeInteger(intent.amountNgnKobo) || intent.amountNgnKobo! <= 0 || !['started', 'ready'].includes(initialization?.state) ||
        (binding && Object.entries(binding).some(([key, value]) => initialization[key] !== value))) {
      throw new ConflictException('Funding request ID is already bound to different payment details or requires reconciliation');
    }
    if (!['pending', 'completed'].includes(intent.status)) throw new ConflictException('Funding request requires reconciliation');
    let authorizationUrl: string | undefined;
    if (intent.status === 'pending' && initialization.state === 'ready') {
      if (initialization.domain !== this.paystackService.paymentDomain()) throw new ConflictException('Stored checkout belongs to a different payment mode');
      const url = new URL(initialization.checkoutUrl);
      if (url.origin !== 'https://checkout.paystack.com' || url.username || url.password || url.hash) throw new ConflictException('Stored checkout requires reconciliation');
      authorizationUrl = url.href;
    }
    return { status: intent.status, requestId: metadata.fundingRequestId, reference: intent.reference,
      transactionId: intent.id, amountUsd: intent.amountUsdCents / 100, amountNgn: intent.amountNgnKobo! / 100,
      checkoutReady: Boolean(authorizationUrl), ...(authorizationUrl ? { authorizationUrl } : {}) };
  }

  async recoverFundingRequest(userId: string, requestId: string) {
    const intent = await this.readFundingRequest(userId, requestId);
    if (!intent) throw new NotFoundException('Funding request not found for this account');
    return this.fundingRequestView(intent);
  }

  /** Owner-scoped read followed by server verification; pending/unknown is never a failed payment. */
  async verifyFunding(reference: string, userId: string) {
    if (!userId) throw new UnauthorizedException('Authenticated owner required');
    const [tx] = await this.db.select().from(billingTransactions)
      .where(and(eq(billingTransactions.reference, reference), eq(billingTransactions.userId, userId),
        eq(billingTransactions.type, 'wallet_fund'), eq(billingTransactions.provider, 'paystack'))).limit(1);
    if (!tx) throw new NotFoundException('Funding reference not found');
    if (tx.status === 'completed') return { status: 'already_completed', transaction: tx };
    if (tx.status !== 'pending') throw new ConflictException('Funding status requires reconciliation');
    const data = await this.paystackService.verifyTransaction(reference);
    if (data.reference !== reference) throw new ConflictException('Provider reference does not match funding intent');
    if (data.status !== 'success') return { status: 'pending', reference, transactionId: tx.id };
    return { status: 'completed', transaction: await this.completeSuccessfulFunding(tx.id, data) };
  }

  /** The ONLY funding credit boundary, shared by owner verification and signed webhooks. */
  async completeSuccessfulFunding(transactionId: string, data: any) {
    const completed = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`wallet-fund:${transactionId}`}, 0))`);
      const [intent] = await tx.select().from(billingTransactions).where(eq(billingTransactions.id, transactionId)).for('update');
      if (!intent) throw new NotFoundException('Funding transaction not found');
      let metadata: any;
      try { metadata = JSON.parse(intent.metadata || '{}'); } catch { throw new ConflictException('Funding metadata requires reconciliation'); }
      let providerMetadata = data?.metadata;
      if (typeof providerMetadata === 'string') { try { providerMetadata = JSON.parse(providerMetadata); } catch { providerMetadata = null; } }
      if (intent.type !== 'wallet_fund' || intent.provider !== 'paystack' || data?.status !== 'success' ||
          !intent.reference || data.reference !== intent.reference || data.currency !== 'NGN' || data.domain !== this.paystackService.paymentDomain() ||
          !Number.isSafeInteger(data.amount) || data.amount <= 0 || data.amount !== intent.amountNgnKobo ||
          !Number.isSafeInteger(intent.amountUsdCents) || intent.amountUsdCents <= 0 || intent.amountUsdCents > 2147483647 ||
          (providerMetadata?.userId && providerMetadata.userId !== intent.userId) ||
          (providerMetadata?.transactionId && providerMetadata.transactionId !== intent.id) ||
          (metadata.fundingVersion === 2 && (providerMetadata?.userId !== intent.userId || providerMetadata?.transactionId !== intent.id ||
            data.customer?.email?.toLowerCase().trim() !== metadata.expectedEmail))) {
        throw new ConflictException('Provider payment does not match the stored funding intent');
      }
      const key = `wallet-fund:v2:${intent.id}`;
      if (intent.status === 'completed') return intent; // Legacy completed rows never receive another credit.
      if (metadata.fundingVersion !== 2 || intent.status !== 'pending' || (intent.idempotencyKey && intent.idempotencyKey !== key)) {
        throw new ConflictException('Funding status requires reconciliation');
      }
      await tx.insert(billingWallets).values({ userId: intent.userId, balanceUsdCents: 0, lockedUsdCents: 0 }).onConflictDoNothing({ target: billingWallets.userId });
      const [wallet] = await tx.select().from(billingWallets).where(eq(billingWallets.userId, intent.userId)).for('update');
      const balance = wallet?.balanceUsdCents + intent.amountUsdCents;
      if (!wallet || !Number.isInteger(wallet.balanceUsdCents) || wallet.balanceUsdCents < 0 || !Number.isSafeInteger(balance) || balance > 2147483647) {
        throw new ConflictException('Wallet balance requires reconciliation or exceeds its limit');
      }
      await tx.update(billingWallets).set({ balanceUsdCents: balance, version: sql`${billingWallets.version} + 1`, updatedAt: new Date() })
        .where(eq(billingWallets.userId, intent.userId));
      const [record] = await tx.update(billingTransactions).set({ status: 'completed', idempotencyKey: key,
        balanceBeforeUsdCents: wallet.balanceUsdCents, balanceAfterUsdCents: balance, updatedAt: new Date(),
        metadata: JSON.stringify({ ...metadata, fundingCompletion: { version: 2, reference: data.reference, currency: data.currency,
          domain: data.domain, amountNgnKobo: data.amount } }),
      }).where(eq(billingTransactions.id, intent.id)).returning();
      return record;
    }, { isolationLevel: 'read committed' });
    // Card storage is separate from money. A storage failure cannot roll back or repeat a credit.
    await this.saveFundingCard(completed, data);
    return completed;
  }

  private async saveFundingCard(intent: typeof billingTransactions.$inferSelect, data: any) {
    let metadata: any;
    try { metadata = JSON.parse(intent.metadata || '{}'); } catch { return; }
    const auth = data.authorization;
    if (metadata.saveCard !== true || auth?.reusable !== true || auth.channel !== 'card' ||
        typeof auth.authorization_code !== 'string' || !auth.authorization_code || typeof auth.signature !== 'string' || !auth.signature ||
        !/^\d{4}$/.test(auth.last4 || '') || !/^(0?[1-9]|1[0-2])$/.test(auth.exp_month || '') || !/^\d{4}$/.test(auth.exp_year || '')) return;
    try {
      await this.db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '8s'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`funding-card:${intent.userId}`}, 0))`);
        const [existing] = await tx.select().from(billingSavedCards)
          .where(and(eq(billingSavedCards.userId, intent.userId), eq(billingSavedCards.provider, 'paystack'), eq(billingSavedCards.signature, auth.signature)));
        if (!existing) await tx.insert(billingSavedCards).values({ userId: intent.userId, provider: 'paystack',
          providerToken: auth.authorization_code, signature: auth.signature, last4: auth.last4, expMonth: auth.exp_month,
          expYear: auth.exp_year, cardBrand: (auth.brand || 'card').slice(0, 30), billingEmail: metadata.expectedEmail, isDefault: false });
      }, { isolationLevel: 'read committed' });
    } catch { this.logger.warn('Funding completed; optional card storage needs retry'); }
  }

  // ─── Ecosystem Internal Wallet Methods ────────────────────────────────────────

  async lockFunds(userId: string, amountUsdCents: number, reason: string): Promise<boolean> {
    const wallet = await this.getOrCreateWallet(userId);

    if (wallet.balanceUsdCents < amountUsdCents) {
      throw new BadRequestException('Insufficient wallet balance to lock funds');
    }

    await this.db
      .update(billingWallets)
      .set({
        balanceUsdCents: sql`${billingWallets.balanceUsdCents} - ${amountUsdCents}`,
        lockedUsdCents: sql`${billingWallets.lockedUsdCents} + ${amountUsdCents}`,
        updatedAt: new Date(),
      })
      .where(eq(billingWallets.userId, userId));

    return true;
  }

  async unlockFunds(userId: string, amountUsdCents: number, reason: string): Promise<boolean> {
    await this.db
      .update(billingWallets)
      .set({
        lockedUsdCents: sql`GREATEST(0, ${billingWallets.lockedUsdCents} - ${amountUsdCents})`,
        balanceUsdCents: sql`${billingWallets.balanceUsdCents} + ${amountUsdCents}`,
        updatedAt: new Date(),
      })
      .where(eq(billingWallets.userId, userId));

    return true;
  }

  async deductLockedFunds(userId: string, amountUsdCents: number, description: string): Promise<boolean> {
    await this.db
      .update(billingWallets)
      .set({
        lockedUsdCents: sql`GREATEST(0, ${billingWallets.lockedUsdCents} - ${amountUsdCents})`,
        updatedAt: new Date(),
      })
      .where(eq(billingWallets.userId, userId));

    return true;
  }

  async creditEarnings(userId: string, amountUsdCents: number, description: string): Promise<boolean> {
    await this.getOrCreateWallet(userId);

    await this.db
      .update(billingWallets)
      .set({
        balanceUsdCents: sql`${billingWallets.balanceUsdCents} + ${amountUsdCents}`,
        updatedAt: new Date(),
      })
      .where(eq(billingWallets.userId, userId));

    return true;
  }
}
