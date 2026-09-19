import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  billingProviderEvents,
  billingTransactions,
  billingWallets,
  billingWithdrawalRequests,
  billingSubscriptions,
} from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { PaystackService } from '../providers/paystack.service';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystackService: PaystackService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Handle incoming Paystack webhook with idempotency protection
   */
  async handlePaystackWebhook(rawBody: string, signature: string) {
    const isValid = this.paystackService.verifyWebhookSignature(signature, rawBody);
    if (!isValid && process.env.NODE_ENV === 'production') {
      this.logger.warn('Paystack webhook signature verification failed');
      throw new BadRequestException('Invalid webhook signature');
    }

    let event: any;
    try {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    const eventType = event.event;
    const eventData = event.data;
    const reference = eventData?.reference || eventData?.transfer_code || `${eventType}_${Date.now()}`;

    this.logger.log(`Received Paystack event: ${eventType} (ref: ${reference})`);

    // Idempotency Check in billing_provider_events
    try {
      const [existingEvent] = await this.db
        .select()
        .from(billingProviderEvents)
        .where(
          and(
            eq(billingProviderEvents.provider, 'paystack'),
            eq(billingProviderEvents.reference, reference),
          ),
        )
        .limit(1);

      if (existingEvent && existingEvent.processed) {
        this.logger.log(`Paystack event ${reference} already processed. Skipping duplicate.`);
        return { status: 'already_processed' };
      }

      if (!existingEvent) {
        await this.db.insert(billingProviderEvents).values({
          provider: 'paystack',
          reference,
          eventType,
          rawPayload: event,
          processed: false,
        });
      }
    } catch (err: any) {
      this.logger.warn(`Idempotency check warning: ${err.message}`);
    }

    // Process specific events
    try {
      switch (eventType) {
        case 'charge.success':
          await this.handleChargeSuccess(eventData);
          break;

        case 'transfer.success':
          await this.handleTransferSuccess(eventData);
          break;

        case 'transfer.failed':
        case 'transfer.reversed':
          await this.handleTransferFailed(eventData);
          break;

        default:
          this.logger.log(`Unhandled Paystack event: ${eventType}`);
      }

      // Mark event as processed
      await this.db
        .update(billingProviderEvents)
        .set({ processed: true, processedAt: new Date() })
        .where(
          and(
            eq(billingProviderEvents.provider, 'paystack'),
            eq(billingProviderEvents.reference, reference),
          ),
        );

      return { status: 'success' };
    } catch (err: any) {
      this.logger.error(`Error processing webhook event ${eventType}: ${err.message}`);
      await this.db
        .update(billingProviderEvents)
        .set({ errorMessage: err.message })
        .where(
          and(
            eq(billingProviderEvents.provider, 'paystack'),
            eq(billingProviderEvents.reference, reference),
          ),
        );
      throw err;
    }
  }

  /**
   * Process charge.success
   */
  private async handleChargeSuccess(data: any) {
    const reference = data.reference;

    const [tx] = await this.db
      .select()
      .from(billingTransactions)
      .where(eq(billingTransactions.reference, reference))
      .limit(1);

    if (!tx) {
      this.logger.warn(`No pending transaction found for reference: ${reference}`);
      return;
    }

    if (tx.status === 'completed') {
      return;
    }

    if (tx.type === 'wallet_fund') {
      await this.walletService.completeSuccessfulFunding(tx.id, data);
      this.logger.log(`Successfully credited wallet for user ${tx.userId} from webhook`);
    } else if (tx.type === 'subscription_charge' || tx.type === 'subscription_renewal') {
      let meta: any = {};
      try {
        meta = tx.metadata ? JSON.parse(tx.metadata) : {};
      } catch {}

      const subId = meta?.subscriptionId;
      if (subId) {
        await this.db
          .update(billingSubscriptions)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(billingSubscriptions.id, subId));
      }
      await this.db
        .update(billingTransactions)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(billingTransactions.id, tx.id));
    }
  }

  /**
   * Process transfer.success (Withdrawal completed)
   */
  private async handleTransferSuccess(data: any) {
    const reference = data.reference;
    const transferCode = data.transfer_code;

    const [wdr] = await this.db
      .select()
      .from(billingWithdrawalRequests)
      .where(eq(billingWithdrawalRequests.paystackTransferCode, transferCode))
      .limit(1);

    if (wdr) {
      // Deduct locked funds permanently
      await this.db
        .update(billingWallets)
        .set({
          lockedUsdCents: sql`GREATEST(0, ${billingWallets.lockedUsdCents} - ${wdr.amountUsdCents})`,
          updatedAt: new Date(),
        })
        .where(eq(billingWallets.userId, wdr.userId));

      // Mark withdrawal request as completed
      await this.db
        .update(billingWithdrawalRequests)
        .set({ status: 'completed', processedAt: new Date(), updatedAt: new Date() })
        .where(eq(billingWithdrawalRequests.id, wdr.id));

      // Mark transaction as completed
      await this.db
        .update(billingTransactions)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(billingTransactions.reference, reference));

      this.logger.log(`Withdrawal ${wdr.id} successfully completed`);
    }
  }

  /**
   * Process transfer.failed or transfer.reversed (Refund locked funds to available balance)
   */
  private async handleTransferFailed(data: any) {
    const reference = data.reference;
    const transferCode = data.transfer_code;

    const [wdr] = await this.db
      .select()
      .from(billingWithdrawalRequests)
      .where(eq(billingWithdrawalRequests.paystackTransferCode, transferCode))
      .limit(1);

    if (wdr) {
      await this.walletService.unlockFunds(wdr.userId, wdr.amountUsdCents, 'Withdrawal transfer failed');

      await this.db
        .update(billingWithdrawalRequests)
        .set({
          status: 'failed',
          failureReason: data.reason || 'Paystack transfer failed',
          updatedAt: new Date(),
        })
        .where(eq(billingWithdrawalRequests.id, wdr.id));

      await this.db
        .update(billingTransactions)
        .set({
          status: 'failed',
          failureReason: data.reason || 'Transfer failed',
          updatedAt: new Date(),
        })
        .where(eq(billingTransactions.reference, reference));

      this.logger.warn(`Withdrawal ${wdr.id} failed and USD funds returned to wallet`);
    }
  }
}
