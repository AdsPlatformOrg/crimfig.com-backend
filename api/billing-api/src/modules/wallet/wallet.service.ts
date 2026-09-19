import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingWallets, billingTransactions, billingSavedCards } from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
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
      .returning();

    return created;
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

    const availableNgn = await this.fxService.convertUsdCentsToNgn(availableUsdCents, fx.rate);
    const totalNgn = await this.fxService.convertUsdCentsToNgn(totalUsdCents, fx.rate);

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
    saveCard?: boolean;
    savedCardId?: string;
    callbackUrl?: string;
  }) {
    if (params.amountUsd < 1) {
      throw new BadRequestException('Minimum funding amount is $1.00 USD');
    }

    const usdCents = Math.round(params.amountUsd * 100);
    const fx = await this.fxService.getUsdToNgnRate();
    const conversion = await this.fxService.convertUsdCentsToNgn(usdCents, fx.rate);

    const reference = `crimfig_fund_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // If user provided a savedCardId, charge saved authorization directly
    if (params.savedCardId) {
      const [savedCard] = await this.db
        .select()
        .from(billingSavedCards)
        .where(and(eq(billingSavedCards.id, params.savedCardId), eq(billingSavedCards.userId, params.userId)))
        .limit(1);

      if (!savedCard) {
        throw new BadRequestException('Invalid or inactive saved card');
      }

      // Record pending transaction
      const [tx] = await this.db
        .insert(billingTransactions)
        .values({
          userId: params.userId,
          type: 'wallet_fund',
          status: 'pending',
          provider: 'paystack',
          reference,
          amountUsdCents: usdCents,
          amountNgnKobo: conversion.ngnKobo,
          exchangeRateId: fx.rateId,
          metadata: JSON.stringify({
            saveCard: false,
            savedCardId: savedCard.id,
            description: `Fund Wallet $${params.amountUsd} via Saved Card (**** ${savedCard.last4})`,
          }),
        })
        .returning();

      try {
        const paystackRes = await this.paystackService.chargeAuthorization({
          email: params.userEmail,
          amountKobo: conversion.ngnKobo,
          authorizationCode: savedCard.providerToken,
          metadata: { transactionId: tx.id, userId: params.userId },
        });

        if (paystackRes.status === 'success') {
          await this.completeSuccessfulFunding(tx.id, paystackRes);
          return {
            status: 'completed',
            reference,
            transactionId: tx.id,
            amountUsd: params.amountUsd,
            amountNgn: conversion.ngnAmount,
            message: 'Funding successful via saved card',
          };
        }
      } catch (err: any) {
        this.logger.error(`Saved card charge failed: ${err.message}`);
        await this.db
          .update(billingTransactions)
          .set({ status: 'failed', failureReason: err.message, updatedAt: new Date() })
          .where(eq(billingTransactions.id, tx.id));
        throw new BadRequestException(`Card charge failed: ${err.message}`);
      }
    }

    // Standard Paystack checkout session
    const saveCardPref = params.saveCard !== false;

    const paystackSession = await this.paystackService.initializeTransaction({
      email: params.userEmail,
      amountKobo: conversion.ngnKobo,
      callbackUrl: params.callbackUrl,
      metadata: {
        userId: params.userId,
        usdCents,
        saveCard: saveCardPref,
      },
    });

    const [tx] = await this.db
      .insert(billingTransactions)
      .values({
        userId: params.userId,
        type: 'wallet_fund',
        status: 'pending',
        provider: 'paystack',
        reference: paystackSession.reference,
        amountUsdCents: usdCents,
        amountNgnKobo: conversion.ngnKobo,
        exchangeRateId: fx.rateId,
        metadata: JSON.stringify({
          saveCard: saveCardPref,
          paystackAccessCode: paystackSession.access_code,
          description: `Fund Wallet $${params.amountUsd.toFixed(2)} USD (₦${conversion.ngnAmount.toLocaleString()} NGN)`,
        }),
      })
      .returning();

    return {
      status: 'pending',
      authorizationUrl: paystackSession.authorization_url,
      reference: paystackSession.reference,
      accessCode: paystackSession.access_code,
      transactionId: tx.id,
      amountUsd: params.amountUsd,
      amountNgn: conversion.ngnAmount,
      exchangeRate: fx.rate,
    };
  }

  /**
   * Verify funding transaction and credit wallet
   */
  async verifyFunding(reference: string, userId?: string) {
    const [tx] = await this.db
      .select()
      .from(billingTransactions)
      .where(eq(billingTransactions.reference, reference))
      .limit(1);

    if (!tx) {
      throw new NotFoundException('Transaction reference not found');
    }

    if (userId && tx.userId !== userId) {
      throw new BadRequestException('Transaction does not belong to this user');
    }

    if (tx.status === 'completed') {
      return { status: 'already_completed', transaction: tx };
    }

    const paystackData = await this.paystackService.verifyTransaction(reference);

    if (paystackData.status === 'success') {
      const updatedTx = await this.completeSuccessfulFunding(tx.id, paystackData);
      return { status: 'completed', transaction: updatedTx };
    } else {
      await this.db
        .update(billingTransactions)
        .set({ status: 'failed', failureReason: paystackData.gateway_response, updatedAt: new Date() })
        .where(eq(billingTransactions.id, tx.id));

      return { status: 'failed', reason: paystackData.gateway_response };
    }
  }

  /**
   * Internal helper: credit wallet, save card if consented, update transaction
   */
  async completeSuccessfulFunding(transactionId: string, paystackData: any) {
    const [tx] = await this.db
      .select()
      .from(billingTransactions)
      .where(eq(billingTransactions.id, transactionId))
      .limit(1);

    if (!tx || tx.status === 'completed') {
      return tx;
    }

    // 1. Credit wallet
    await this.db
      .update(billingWallets)
      .set({
        balanceUsdCents: sql`${billingWallets.balanceUsdCents} + ${tx.amountUsdCents}`,
        updatedAt: new Date(),
      })
      .where(eq(billingWallets.userId, tx.userId));

    // 2. Process card saving if requested and authorization returned
    let meta: any = {};
    try {
      meta = tx.metadata ? JSON.parse(tx.metadata) : {};
    } catch {}

    const auth = paystackData.authorization;
    if (meta.saveCard !== false && auth && auth.reusable && auth.authorization_code) {
      try {
        const [existingCard] = await this.db
          .select()
          .from(billingSavedCards)
          .where(
            and(
              eq(billingSavedCards.userId, tx.userId),
              eq(billingSavedCards.signature, auth.signature || ''),
            ),
          )
          .limit(1);

        if (!existingCard) {
          await this.db.insert(billingSavedCards).values({
            userId: tx.userId,
            provider: 'paystack',
            providerToken: auth.authorization_code,
            last4: auth.last4,
            expMonth: auth.exp_month,
            expYear: auth.exp_year,
            cardBrand: auth.brand || auth.card_type || 'card',
            cardType: auth.card_type,
            bank: auth.bank,
            signature: auth.signature,
            billingEmail: paystackData.customer?.email,
            isDefault: false,
          });
        }
      } catch (err: any) {
        this.logger.warn(`Could not save card token: ${err.message}`);
      }
    }

    // 3. Mark transaction completed
    const [updated] = await this.db
      .update(billingTransactions)
      .set({
        status: 'completed',
        updatedAt: new Date(),
      })
      .where(eq(billingTransactions.id, tx.id))
      .returning();

    return updated;
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
