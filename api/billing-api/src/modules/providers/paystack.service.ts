import { PaystackBrokerClient } from './paystack-broker.client';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';

export interface PaystackInitResponse {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    domain: string;
    status: 'success' | 'failed' | 'abandoned';
    reference: string;
    amount: number; // in kobo
    gateway_response: string;
    paid_at: string;
    channel: string;
    currency: string;
    authorization?: {
      authorization_code: string;
      bin: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      channel: string;
      card_type: string;
      bank: string;
      country_code: string;
      brand: string;
      reusable: boolean;
      signature: string;
      account_name: string | null;
    };
    customer: {
      id: number;
      email: string;
      customer_code: string;
    };
    metadata?: any;
  };
}

export interface PaystackRecipientResponse {
  recipient_code: string;
  details: {
    account_number: string;
    account_name: string;
    bank_code: string;
    bank_name: string;
  };
}

export interface PaystackTransferResponse {
  transfer_code: string;
  reference: string;
  status: string;
}

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly secretKey = 'isolated-provider-gateway';
  private readonly broker = new PaystackBrokerClient();
  private readonly request = (url: string, init?: RequestInit) => this.broker.request(url, init);
  private readonly baseUrl = 'https://api.paystack.co';

  paymentDomain(): 'test' | 'live' {
    const mode = process.env.PAYSTACK_MODE === 'live' ? 'live' : process.env.PAYSTACK_MODE === 'test' ? 'test' : null;
    const staging = process.env.RAILWAY_ENVIRONMENT_NAME === 'staging';
    const expected = process.env.PAYSTACK_MODE || (staging ? 'test' : process.env.NODE_ENV === 'production' ? 'live' : mode);
    if (!mode || mode !== expected || (staging && mode !== 'test') || (process.env.NODE_ENV === 'production' && !staging && mode !== 'live')) {
      throw new ServiceUnavailableException('Payment provider key/mode is not configured for funding');
    }
    return mode;
  }

  /**
   * Verify HMAC-SHA512 webhook signature from Paystack
   */
  async verifyWebhookSignature(signature: string, rawBody: string | Buffer): Promise<boolean> {
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    return this.broker.verifyWebhook(rawBody, signature);
  }

  /**
   * Initialize a charge transaction
   */
  async initializeTransaction(params: {
    email: string;
    amountKobo: number;
    reference?: string;
    callbackUrl?: string;
    metadata?: Record<string, any>;
    channels?: string[];
  }): Promise<PaystackInitResponse> {
    this.paymentDomain();
    try {
      const res = await this.request(`${this.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          email: params.email,
          amount: params.amountKobo,
          currency: 'NGN',
          reference: params.reference,
          callback_url: params.callbackUrl,
          metadata: params.metadata,
          channels: params.channels || ['card', 'bank', 'ussd', 'bank_transfer'],
        }),
      });

      const json: any = await res.json();
      if (!res.ok || json.status !== true) {
        throw new Error(json.message || 'Paystack initialization failed');
      }
      return json.data;
    } catch (err: any) {
      this.logger.error(`initializeTransaction error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Verify a transaction by reference
   */
  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse['data']> {
    this.paymentDomain();
    try {
      const res = await this.request(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      const json: any = await res.json();
      if (!res.ok || json.status !== true) {
        throw new Error(json.message || 'Paystack transaction verification failed');
      }
      return json.data;
    } catch (err: any) {
      this.logger.error(`verifyTransaction error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Charge a saved authorization code (recurrent/saved card charge)
   */
  async chargeAuthorization(params: {
    email: string;
    amountKobo: number;
    authorizationCode: string;
    reference: string;
    metadata?: Record<string, any>;
  }): Promise<PaystackVerifyResponse['data']> {
    this.paymentDomain();
    if (!/^[a-zA-Z0-9.=-]{1,200}$/.test(params.reference) || !Number.isSafeInteger(params.amountKobo) || params.amountKobo <= 0) throw new ServiceUnavailableException('Invalid durable charge reference or amount');
    try {
      const res = await this.request(`${this.baseUrl}/transaction/charge_authorization`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: params.email,
          amount: params.amountKobo,
          currency: 'NGN',
          reference: params.reference,
          authorization_code: params.authorizationCode,
          metadata: params.metadata,
        }),
      });

      const json: any = await res.json();
      if (!res.ok || json.status !== true) {
        throw new Error(json.message || 'Paystack charge authorization failed');
      }
      return json.data;
    } catch (err: any) {
      this.logger.error('Saved authorization charge could not be confirmed');
      throw err;
    }
  }

  /**
   * Deactivate a saved authorization so it can no longer be charged.
   * Success requires an explicit provider confirmation (HTTP ok AND status === true).
   * The authorization code is never logged.
   */
  async deactivateAuthorization(authorizationCode: string): Promise<void> {
    if (typeof authorizationCode !== 'string' || !authorizationCode.trim()) {
      throw new Error('Authorization code is required');
    }
    try {
      const res = await this.request(`${this.baseUrl}/customer/deactivate_authorization`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ authorization_code: authorizationCode }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || json.status !== true) {
        throw new Error(json.message || 'Paystack authorization deactivation was not confirmed');
      }
    } catch (err: any) {
      this.logger.error(`deactivateAuthorization error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get list of Nigerian banks supported by Paystack
   */
  async listBanks(): Promise<Array<{ name: string; code: string; slug: string; id: number }>> {
    this.paymentDomain();
    try {
      const res = await this.request(`${this.baseUrl}/bank?country=nigeria&perPage=100`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      const json: any = await res.json();
      if (!res.ok || json.status !== true || !Array.isArray(json.data)) throw new Error('Bank directory unavailable');
      return json.data;
    } catch (err: any) {
      this.logger.error(`listBanks error: ${err.message}`);
      throw new ServiceUnavailableException('Bank directory is temporarily unavailable');
    }
  }

  /**
   * Resolve NUBAN account number and bank code to verified account name
   */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<{
    account_number: string;
    account_name: string;
    bank_id: number;
  }> {
    this.paymentDomain();
    if (!/^\d{10}$/.test(accountNumber) || !/^\d{3,10}$/.test(bankCode)) throw new ServiceUnavailableException('Invalid bank account details');
    try {
      const res = await this.request(
        `${this.baseUrl}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        {
          headers: { Authorization: `Bearer ${this.secretKey}` },
          redirect: 'error', signal: AbortSignal.timeout(10000),
        },
      );
      const json: any = await res.json();
      if (!res.ok || json.status !== true || json.data?.account_number !== accountNumber ||
        typeof json.data?.account_name !== 'string' || !json.data.account_name.trim()) {
        throw new Error(json.message || 'Could not resolve bank account details');
      }
      return json.data;
    } catch (err: any) {
      this.logger.error(`resolveAccount error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Create a Paystack transfer recipient for payouts
   */
  async createTransferRecipient(params: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }): Promise<PaystackRecipientResponse> {
    this.paymentDomain();
    if (!/^\d{10}$/.test(params.accountNumber) || !/^\d{3,10}$/.test(params.bankCode) || !params.name.trim() || params.name.length > 255) throw new ServiceUnavailableException('Invalid transfer recipient');
    try {
      const res = await this.request(`${this.baseUrl}/transferrecipient`, {
        method: 'POST',
        redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'nuban',
          name: params.name,
          account_number: params.accountNumber,
          bank_code: params.bankCode,
          currency: 'NGN',
        }),
      });
      const json: any = await res.json();
      if (!res.ok || json.status !== true || !/^RCP_[A-Za-z0-9]+$/.test(json.data?.recipient_code || '') ||
        json.data?.details?.account_number !== params.accountNumber || String(json.data?.details?.bank_code) !== params.bankCode) {
        throw new Error(json.message || 'Failed to create transfer recipient');
      }
      return json.data;
    } catch (err: any) {
      this.logger.error(`createTransferRecipient error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Initiate a Paystack Transfer (payout to recipient)
   */
  async initiateTransfer(params: {
    amountKobo: number;
    recipientCode: string;
    reason?: string;
    reference: string;
  }): Promise<PaystackTransferResponse> {
    throw new ServiceUnavailableException('Direct Billing payouts are disabled. Use the independent withdrawal execution authority.');
  }
  
  /** Read-only recovery. Not-found/timeout does not prove a transfer was never dispatched. */
  async verifyTransfer(reference: string): Promise<unknown> {
    this.paymentDomain();
    if (!/^[a-z0-9_-]{16,50}$/.test(reference)) throw new Error('Invalid transfer reference');
    const res = await this.request(`${this.baseUrl}/transfer/verify/${encodeURIComponent(reference)}`, {
      redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const json: any = await res.json();
    if (!res.ok || json?.status !== true || !json.data || json.data.reference !== reference) {
      throw new Error('Transfer recovery unavailable');
    }
    return json.data;
  }
}
