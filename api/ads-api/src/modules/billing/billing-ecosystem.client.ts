import { Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
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

/** Server-only Billing boundary. Never retry financial writes after ambiguous failures. */
@Injectable()
export class BillingEcosystemClient {
  private readonly billingApiUrl: string;
  private readonly internalKey: string;

  constructor(config: ConfigService) {
    const url = new URL(config.get<string>('BILLING_API_URL') || 'http://127.0.0.1:3008/api/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('BILLING_API_URL must be an HTTP(S) service URL without credentials, query or fragment');
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path && path !== '/api/v1') throw new Error('BILLING_API_URL must use the service root or /api/v1');
    this.billingApiUrl = `${url.origin}/api/v1`;
    this.internalKey = config.get<string>('INTERNAL_ECOSYSTEM_KEY') || '';
  }

  private async request(userId: string, action: string, body?: Record<string, unknown>): Promise<any> {
    if (!this.internalKey) throw new ServiceUnavailableException('Billing service authorization is not configured');
    if (typeof userId !== 'string' || !userId.trim()) throw new BadRequestException('Wallet owner is required');
    try {
      const response = await fetch(`${this.billingApiUrl}/ecosystem/wallets/${encodeURIComponent(userId)}/${action}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': this.internalKey },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Billing rejected request');
      const json = await response.json() as any;
      if (json?.status !== 'success') throw new Error('Invalid Billing acknowledgement');
      return json.data;
    } catch {
      // Do not expose provider bodies, internal secrets or a fabricated success to callers.
      throw new ServiceUnavailableException('Billing request could not be confirmed; reconcile before retrying financial operations');
    }
  }

  async getWalletBalance(userId: string): Promise<WalletBalanceResponse> {
    const data = await this.request(userId, 'balance');
    const usd = data?.usd;
    const ngn = data?.ngnEquivalent;
    const cents = [usd?.availableCents, usd?.lockedCents, usd?.totalCents];
    if (data?.userId !== userId || !cents.every(value => Number.isSafeInteger(value) && value >= 0) ||
        usd.totalCents !== usd.availableCents + usd.lockedCents ||
        !Number.isFinite(ngn?.availableAmount) || ngn.availableAmount < 0 ||
        !Number.isFinite(ngn?.exchangeRate) || ngn.exchangeRate <= 0) {
      throw new ServiceUnavailableException('Billing returned an invalid wallet balance');
    }
    return {
      userId, availableUsdCents: usd.availableCents, lockedUsdCents: usd.lockedCents,
      totalUsdCents: usd.totalCents, availableUsd: usd.availableCents / 100,
      lockedUsd: usd.lockedCents / 100, totalUsd: usd.totalCents / 100,
      estimatedAvailableNgn: ngn.availableAmount, exchangeRate: ngn.exchangeRate,
    };
  }

  async settleCampaign(campaignId: string, requestId: string, periodEnd: string) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(campaignId) || !uuid.test(requestId) || !Number.isFinite(Date.parse(periodEnd)) || Date.parse(periodEnd) > Date.now()) {
      throw new BadRequestException('A campaign, durable request UUID and closed period are required');
    }
    if (!this.internalKey) throw new ServiceUnavailableException('Billing service authorization is not configured');
    try {
      const response = await fetch(`${this.billingApiUrl}/ecosystem/campaigns/${campaignId}/settlements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-key': this.internalKey },
        body: JSON.stringify({ requestId, periodEnd }), redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      const json = await response.json() as any;
      const data = json?.data;
      if (!response.ok || json?.status !== 'success' || !uuid.test(data?.batchId) || data?.status !== 'completed' ||
        !Number.isSafeInteger(data?.billedUsdCents) || data.billedUsdCents < 0 || typeof data?.replayed !== 'boolean') {
        throw new Error('Invalid settlement acknowledgement');
      }
      return data;
    } catch {
      throw new ServiceUnavailableException('Settlement is unconfirmed; recover using the same request UUID and period');
    }
  }

  private checkedEscrow(data: any, userId: string, campaignId: string, action: 'reserve' | 'release') {
    const escrow = data?.escrow;
    const cents = [escrow?.allocatedUsdCents, escrow?.consumedUsdCents, escrow?.refundedUsdCents];
    if (escrow?.userId !== userId || escrow?.campaignId !== campaignId || typeof escrow?.id !== 'string' ||
        !cents.every(value => Number.isSafeInteger(value) && value >= 0) ||
        escrow.consumedUsdCents + escrow.refundedUsdCents > escrow.allocatedUsdCents ||
        escrow.status !== (action === 'reserve' ? 'active' : 'released') ||
        data?.operationId !== `ads-escrow:v2:${escrow.id}:${action}:${escrow.allocatedUsdCents}` ||
        typeof data?.transactionId !== 'string' || !data.transactionId || typeof data?.replayed !== 'boolean') {
      throw new ServiceUnavailableException('Billing returned an invalid escrow receipt; reconcile before retrying');
    }
    return escrow;
  }

  async reserveCampaignEscrow(userId: string, campaignId: string, amountUsdCents: number) {
    if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents < 500 || amountUsdCents > 2147483647) {
      throw new BadRequestException('Escrow requires 500 to 2147483647 integer USD cents');
    }
    const data = await this.request(userId, `campaign-escrows/${encodeURIComponent(campaignId)}/reserve`, { amountUsdCents, reason: 'Campaign budget reservation' });
    return this.checkedEscrow(data, userId, campaignId, 'reserve');
  }

  async releaseCampaignEscrow(userId: string, campaignId: string) {
    const data = await this.request(userId, `campaign-escrows/${encodeURIComponent(campaignId)}/release`, {});
    return this.checkedEscrow(data, userId, campaignId, 'release');
  }

  async changeCampaignStatus(userId: string, campaignId: string, status: 'active' | 'paused' | 'trash') {
    if (!['active', 'paused', 'trash'].includes(status)) throw new BadRequestException('Unsupported campaign status');
    const data = await this.request(userId, `campaign-escrows/${encodeURIComponent(campaignId)}/status`, { status });
    if (data?.campaign?.id !== campaignId || data?.campaign?.advertiserId !== userId || data?.campaign?.status !== status) {
      throw new ServiceUnavailableException('Billing returned an invalid campaign transition receipt; reconcile before retrying');
    }
    if (data.escrow || status === 'active') this.checkedEscrow(data, userId, campaignId, status === 'active' ? 'reserve' : 'release');
    else if (data.operationId !== null || data.transactionId !== null || data.replayed !== true) {
      throw new ServiceUnavailableException('Billing returned an invalid unfunded campaign transition');
    }
    return data.campaign;
  }

}
