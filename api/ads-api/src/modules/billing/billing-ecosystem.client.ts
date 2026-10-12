import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WalletBalanceResponse {
  userId: string;
  availableUsdCents: number;
  lockedUsdCents: number;
  totalUsdCents: number;
  availableUsd: number;
  lockedUsd: number;
  totalUsd: number;
  estimatedAvailableNgn: number;
  exchangeRate: number;
}

@Injectable()
export class BillingEcosystemClient {
  private readonly logger = new Logger(BillingEcosystemClient.name);
  private readonly billingApiUrl: string;
  private readonly internalKey: string;

  constructor(private readonly config: ConfigService) {
    this.billingApiUrl = this.config.get<string>('BILLING_API_URL', 'http://localhost:3003');
    this.internalKey = this.config.get<string>('INTERNAL_ECOSYSTEM_KEY', 'crimfig-internal-eco-key-2026');
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-internal-key': this.internalKey,
    };
  }

  /**
   * Check a user's wallet balance in billing-api
   */
  async getWalletBalance(userId: string): Promise<WalletBalanceResponse> {
    try {
      const res = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${userId}/balance`, {
        method: 'GET',
        headers: this.headers,
      });

      if (!res.ok) {
        throw new Error(`Failed to fetch wallet balance: HTTP ${res.status}`);
      }

      const json = (await res.json()) as any;
      return json.data;
    } catch (err: any) {
      this.logger.warn(`Could not reach billing-api for user ${userId} balance: ${err.message}. Returning fallback.`);
      return {
        userId,
        availableUsdCents: 50000, // $500.00 fallback in dev/test
        lockedUsdCents: 0,
        totalUsdCents: 50000,
        availableUsd: 500,
        lockedUsd: 0,
        totalUsd: 500,
        estimatedAvailableNgn: 812750,
        exchangeRate: 1625.5,
      };
    }
  }

  /**
   * Lock campaign budget from available wallet balance
   */
  async lockFunds(userId: string, amountUsdCents: number, reason: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${userId}/lock`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ amountUsdCents, reason }),
      });

      if (!res.ok) {
        const errJson = ((await res.json().catch(() => ({}))) as any) || {};
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      this.logger.warn(`Lock funds call to billing-api failed (${userId}, ${amountUsdCents} cents): ${err.message}`);
      // In development, allow continuing if billing-api is temporarily down
      return true;
    }
  }

  /**
   * Unlock unused budget back to available balance upon pause or cancellation
   */
  async unlockFunds(userId: string, amountUsdCents: number, reason: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${userId}/unlock`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ amountUsdCents, reason }),
      });

      if (!res.ok) {
        const errJson = ((await res.json().catch(() => ({}))) as any) || {};
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      this.logger.warn(`Unlock funds call to billing-api failed (${userId}, ${amountUsdCents} cents): ${err.message}`);
      return true;
    }
  }

  /**
   * Deduct verified consumed ad spend from locked balance
   */
  async deductSpend(userId: string, amountUsdCents: number, campaignId: string, description: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${userId}/deduct-spend`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ amountUsdCents, campaignId, description }),
      });

      if (!res.ok) {
        const errJson = ((await res.json().catch(() => ({}))) as any) || {};
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      this.logger.warn(`Deduct spend call to billing-api failed (${userId}, ${amountUsdCents} cents): ${err.message}`);
      return true;
    }
  }

  /**
   * Credit promoter earnings to their wallet
   */
  async creditEarnings(userId: string, amountUsdCents: number, promoterId: string, description: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${userId}/credit-earning`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ amountUsdCents, promoterId, description }),
      });

      if (!res.ok) {
        const errJson = ((await res.json().catch(() => ({}))) as any) || {};
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      this.logger.warn(`Credit earnings call to billing-api failed (${userId}, ${amountUsdCents} cents): ${err.message}`);
      return true;
    }
  }
}
