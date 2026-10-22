import { Injectable, Inject, Logger, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import { billingExchangeRates } from '@crimfig/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { desc } from 'drizzle-orm';

/** Provider updates daily; never extend freshness by reading or re-saving an old quote. */
export const FX_REFRESH_INTERVAL_MINUTES = 24 * 60;
export interface FxRateResult {
  rate: number;
  rateId: string;
  source: 'exchangerate_api';
  fetchedAt: Date;
  providerUpdatedAt: Date;
}
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private cachedRate: FxRateResult | null = null;
  private flight: Promise<FxRateResult> | null = null;
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  private fresh(time: number) {
    const age = Date.now() - time;
    return Number.isFinite(age) && age >= 0 && age < FX_REFRESH_INTERVAL_MINUTES * 60_000;
  }
  private providerQuote(raw: any, keyed: boolean) {
    const rate = keyed ? raw?.conversion_rates?.NGN : raw?.rates?.NGN;
    const updated = raw?.time_last_update_unix;
    if (raw?.result !== 'success' || raw?.base_code !== 'USD' || !Number.isFinite(rate) || rate <= 0 ||
        rate >= 1_000_000_000_000 || !Number.isSafeInteger(updated) || !this.fresh(updated * 1000)) return null;
    const rounded = Number(rate.toFixed(6));
    return rounded > 0 ? { rate: rounded, providerUpdatedAt: new Date(updated * 1000) } : null;
  }
  private storedQuote(row: any): FxRateResult | null {
    if (!row?.id || row.source !== 'exchangerate_api' || !this.fresh(new Date(row.fetchedAt).getTime())) return null;
    const proof = this.providerQuote(row.rawMainResponse, false) ?? this.providerQuote(row.rawFallbackResponse, true);
    if (!proof || Number(row.usdToNgn) !== proof.rate) return null;
    return { ...proof, rateId: row.id, source: 'exchangerate_api', fetchedAt: new Date(row.fetchedAt) };
  }
  /** Validate a persisted snapshot without network/cache refresh, for a locked money transaction. */
  validateStoredRate(row: unknown): FxRateResult {
    const quote = this.storedQuote(row);
    if (!quote) throw new ServiceUnavailableException('A fresh verified FX snapshot is required');
    return quote;
  }
  private usable(quote: FxRateResult) {
    return quote.source === 'exchangerate_api' && Boolean(quote.rateId) && Number.isFinite(quote.rate) && quote.rate > 0 &&
      this.fresh(quote.fetchedAt.getTime()) && this.fresh(quote.providerUpdatedAt.getTime());
  }
  async getUsdToNgnRate(forceRefresh = false): Promise<FxRateResult> {
    if (!forceRefresh && this.cachedRate && this.usable(this.cachedRate)) return { ...this.cachedRate };
    if (this.flight) return this.flight;
    const flight = Promise.resolve().then(() => this.loadRate(forceRefresh));
    this.flight = flight;
    try { return await flight; } finally { if (this.flight === flight) this.flight = null; }
  }
  private async loadRate(forceRefresh: boolean): Promise<FxRateResult> {
    if (!forceRefresh) {
      try {
        const [row] = await this.db.select().from(billingExchangeRates).orderBy(desc(billingExchangeRates.fetchedAt)).limit(1);
        const quote = this.storedQuote(row);
        if (quote) { this.cachedRate = quote; return { ...quote }; }
      } catch { this.logger.warn('FX snapshot read unavailable'); }
    }
    const key = process.env.EXCHANGE_RATE_API_KEY;
    const providers = [{ url: 'https://open.er-api.com/v6/latest/USD', keyed: false }];
    // No embedded/default credential. Never log a provider URL containing a key.
    if (key && /^[a-zA-Z0-9_-]{1,200}$/.test(key)) providers.push({ url: `https://v6.exchangerate-api.com/v6/${key}/latest/USD`, keyed: true });
    for (const provider of providers) {
      try {
        const response = await fetch(provider.url, { redirect: 'error', signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error('FX provider unavailable');
        const raw = await response.json();
        const proof = this.providerQuote(raw, provider.keyed);
        if (!proof) throw new Error('Invalid or stale FX response');
        const [saved] = await this.db.insert(billingExchangeRates).values({
          usdToNgn: proof.rate.toFixed(6), source: 'exchangerate_api',
          rawMainResponse: provider.keyed ? null : raw, rawFallbackResponse: provider.keyed ? raw : null,
          fetchedAt: new Date(),
        }).returning();
        const quote = this.storedQuote(saved);
        if (!quote) throw new Error('FX snapshot persistence unconfirmed');
        this.cachedRate = quote;
        return { ...quote };
      } catch { this.logger.warn('FX provider quote or persistence unavailable'); }
    }
    throw new ServiceUnavailableException('A fresh persisted FX quote is unavailable. No fallback rate was substituted.');
  }
  async convertUsdCentsToNgn(usdCents: number, snapshot?: FxRateResult) {
    this.validAmount(usdCents);
    const fx = snapshot ?? await this.getUsdToNgnRate();
    if (!this.usable(fx)) throw new ServiceUnavailableException('FX quote is no longer fresh');
    const ngnKobo = Math.round(usdCents * fx.rate);
    this.validAmount(ngnKobo);
    return { usdCents, ngnKobo, ngnAmount: ngnKobo / 100, rate: fx.rate, rateId: fx.rateId };
  }
  async convertNgnKoboToUsdCents(ngnKobo: number, snapshot?: FxRateResult) {
    this.validAmount(ngnKobo);
    const fx = snapshot ?? await this.getUsdToNgnRate();
    if (!this.usable(fx)) throw new ServiceUnavailableException('FX quote is no longer fresh');
    const usdCents = Math.round(ngnKobo / fx.rate);
    this.validAmount(usdCents);
    return { ngnKobo, usdCents, usdAmount: usdCents / 100, rate: fx.rate, rateId: fx.rateId };
  }
  private validAmount(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new BadRequestException('Conversion requires non-negative safe integer minor units');
  }
  async getHistory(limit = 30) {
    return this.db.select().from(billingExchangeRates).orderBy(desc(billingExchangeRates.fetchedAt)).limit(limit);
  }
}
