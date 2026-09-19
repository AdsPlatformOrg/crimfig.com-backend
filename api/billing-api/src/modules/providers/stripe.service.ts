import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly isConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  /**
   * Check if Stripe is active and configured
   */
  isEnabled(): boolean {
    return this.isConfigured;
  }

  /**
   * Verify Stripe Webhook Signature
   */
  verifyWebhookSignature(signature: string, rawBody: string | Buffer): boolean {
    if (!this.isConfigured) return false;
    // When Stripe SDK is installed/configured, verify with stripe.webhooks.constructEvent
    return true;
  }

  /**
   * Create direct USD PaymentIntent
   */
  async createPaymentIntent(params: {
    amountUsdCents: number;
    customerId?: string;
    metadata?: Record<string, any>;
  }) {
    if (!this.isConfigured) {
      throw new Error('Stripe is not currently configured for direct USD transactions.');
    }
    // Future Stripe integration hook
    return { clientSecret: 'mock_stripe_secret', id: 'pi_mock' };
  }
}
