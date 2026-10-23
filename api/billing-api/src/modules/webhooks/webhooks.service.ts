import { SubscriptionPaymentsService } from '../subscriptions/subscription-payments.service';
import { WithdrawalLedgerService } from '../withdrawals/withdrawal-ledger.service';
import { Injectable, Inject, Logger, Optional, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  billingProviderEvents,
  billingTransactions,
} from '@crimfig/database/schema';
import { eq, and } from 'drizzle-orm';
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
    @Optional() private readonly withdrawalLedger?: WithdrawalLedgerService,
    @Optional() private readonly subscriptionPayments?: SubscriptionPaymentsService,
  ) {}

  /**
   * Handle incoming Paystack webhook with idempotency protection
   */
  async handlePaystackWebhook(rawBody: string, signature: string) {
    const isValid = this.paystackService.verifyWebhookSignature(signature, rawBody);
    if (!isValid) {
      this.logger.warn('Paystack webhook signature verification failed');
      throw new BadRequestException('Invalid webhook signature');
    }

    let event: any;
    try {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }

    if (!event || typeof event !== 'object' || typeof event.event !== 'string') throw new BadRequestException('Invalid provider event');
    if (event.event === 'charge.success') return this.handleFundingCharge(event);

    if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)) {
      return this.handleTransfer(event);
    }
    return { status: 'ignored' };
  }

  private async handleTransfer(event: any) {
    if (!this.withdrawalLedger) throw new ServiceUnavailableException('Transfer completion authority unavailable; operator reconciliation required');
    const outcome = event.event.slice('transfer.'.length);
    const data = event.data;
    if (data?.status !== outcome || typeof data?.reference !== 'string' || !/^[a-z0-9_-]{16,50}$/.test(data.reference)) {
      throw new BadRequestException('Transfer event identity or outcome mismatch');
    }
    const reference = `${event.event}:${data.reference}`;
    await this.db.insert(billingProviderEvents).values({ provider: 'paystack', reference,
      eventType: event.event, rawPayload: event, processed: false }).onConflictDoNothing();
    try {
      await this.withdrawalLedger.complete(data.reference, data);
      await this.db.update(billingProviderEvents).set({ processed: true, processedAt: new Date(), errorMessage: null })
        .where(and(eq(billingProviderEvents.provider, 'paystack'), eq(billingProviderEvents.reference, reference)));
      return { status: 'success' };
    } catch {
      await this.db.update(billingProviderEvents).set({ errorMessage: 'Transfer outcome requires retry/reconciliation' })
        .where(and(eq(billingProviderEvents.provider, 'paystack'), eq(billingProviderEvents.reference, reference)));
      // Receipt is authoritative even if callback acknowledgement failed after its commit.
      throw new ServiceUnavailableException('Transfer outcome requires retry/reconciliation');
    }
  }

  /** Signed callbacks and owner verification converge on the same atomic funding credit. */
  private async handleFundingCharge(event: any) {
    const data = event.data;
    if (typeof data?.reference !== 'string' || !/^[a-zA-Z0-9._=-]{1,200}$/.test(data.reference)) {
      throw new BadRequestException('A valid payment reference is required');
    }
    const [intent] = await this.db.select().from(billingTransactions)
      .where(and(eq(billingTransactions.reference, data.reference), eq(billingTransactions.provider, 'paystack'))).limit(1);
    if (!intent) throw new ServiceUnavailableException('Funding intent not available; callback must be retried');
    const subscription = ['subscription_charge', 'subscription_renewal'].includes(intent.type);
    if (subscription && !this.subscriptionPayments) throw new ServiceUnavailableException('Subscription completion authority unavailable');
    if (!subscription && intent.type !== 'wallet_fund') throw new ServiceUnavailableException('This charge requires its own verified subscription/payment completion contract');
    // Scope identity by event type. transfer.failed/reversed must never suppress charge.success.
    const reference = `charge.success:${data.reference}`;
    await this.db.insert(billingProviderEvents).values({ provider: 'paystack', reference,
      eventType: 'charge.success', rawPayload: event, processed: false }).onConflictDoNothing();
    try {
      if (subscription) await this.subscriptionPayments!.complete(data.reference, data);
      else await this.walletService.completeSuccessfulFunding(intent.id, data);
      await this.db.update(billingProviderEvents).set({ processed: true, processedAt: new Date(), errorMessage: null })
        .where(and(eq(billingProviderEvents.provider, 'paystack'), eq(billingProviderEvents.reference, reference)));
      return { status: 'success' };
    } catch (error) {
      // The funding receipt remains authoritative if event acknowledgement storage fails after commit.
      await this.db.update(billingProviderEvents).set({ errorMessage: 'Funding confirmation requires retry/reconciliation' })
        .where(and(eq(billingProviderEvents.provider, 'paystack'), eq(billingProviderEvents.reference, reference)));
      throw error;
    }
  }

}
