import { Injectable, Inject, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import { billingExchangeRates } from '@crimfig/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { desc } from 'drizzle-orm';

/**
 * FX CONFIGURATION
 * Easily adjust refresh interval (e.g. 1440 for 24 hours, 60 for hourly, 30 for 30 minutes)
 */
export const FX_REFRESH_INTERVAL_MINUTES = 24 * 60; // 24 hours (daily) default
export const FX_HARDCODED_FALLBACK_RATE = 1550.0;

export interface FxRateResult {
  rate: number;
  rateId: string;
  source: 'frankfurter' | 'exchangerate_api' | 'stale_fallback';
  fetchedAt: Date;
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private cachedRate: FxRateResult | null = null;
  private lastFetchedTimestamp: number = 0;

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get the current USD to NGN exchange rate.
   * In-memory cache -> DB recent entry -> Frankfurter (main) -> ExchangeRate-API (fallback) -> DB stale -> Hardcoded
   */
  async getUsdToNgnRate(forceRefresh = false): Promise<FxRateResult> {
    const now = Date.now();
    const cacheValidDurationMs = FX_REFRESH_INTERVAL_MINUTES * 60 * 1000;

    if (!forceRefresh && this.cachedRate && now - this.lastFetchedTimestamp < cacheValidDurationMs) {
      return this.cachedRate;
    }

    // Check recent DB rate within the interval
    if (!forceRefresh) {
      try {
        const [recentDbRate] = await this.db
          .select()
          .from(billingExchangeRates)
          .orderBy(desc(billingExchangeRates.fetchedAt))
          .limit(1);

        if (recentDbRate && now - new Date(recentDbRate.fetchedAt).getTime() < cacheValidDurationMs) {
          this.cachedRate = {
            rate: Number(recentDbRate.usdToNgn),
            rateId: recentDbRate.id,
            source: recentDbRate.source,
            fetchedAt: new Date(recentDbRate.fetchedAt),
          };
          this.lastFetchedTimestamp = new Date(recentDbRate.fetchedAt).getTime();
          return this.cachedRate;
        }
      } catch (err: any) {
        this.logger.warn(`Could not check recent DB rate: ${err.message}`);
      }
    }

    // Try Primary API: open.er-api.com / Frankfurter
    let mainResponse: any = null;
    try {
      this.logger.log('Fetching live rate from primary provider (open.er-api.com)...');
      const response = await fetch('https://open.er-api.com/v6/latest/USD', {
        headers: { 'User-Agent': 'Crimfig-Billing-Service/1.0' },
        signal: AbortSignal.timeout(6000),
      });

      if (response.ok) {
        mainResponse = await response.json();
        const ngnRate = mainResponse?.rates?.NGN;
        if (typeof ngnRate === 'number' && ngnRate > 0) {
          const saved = await this.saveRateToDatabase(ngnRate, 'frankfurter', mainResponse, null);
          this.cachedRate = {
            rate: ngnRate,
            rateId: saved.id,
            source: 'frankfurter',
            fetchedAt: new Date(),
          };
          this.lastFetchedTimestamp = now;
          this.logger.log(`Primary FX API success: 1 USD = ${ngnRate} NGN`);
          return this.cachedRate;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Primary FX API failed: ${err.message}. Trying fallback provider...`);
    }

    // Try Fallback API: ExchangeRate-API
    let fallbackResponse: any = null;
    try {
      const apiKey = process.env.EXCHANGE_RATE_API_KEY || '1d6ea53daf5c828a815c442e';
      this.logger.log('Fetching live rate from fallback provider (exchangerate-api.com)...');
      const response = await fetch(`https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`, {
        signal: AbortSignal.timeout(6000),
      });

      if (response.ok) {
        fallbackResponse = await response.json();
        const ngnRate = fallbackResponse?.conversion_rates?.NGN;
        if (typeof ngnRate === 'number' && ngnRate > 0) {
          const saved = await this.saveRateToDatabase(ngnRate, 'exchangerate_api', mainResponse, fallbackResponse);
          this.cachedRate = {
            rate: ngnRate,
            rateId: saved.id,
            source: 'exchangerate_api',
            fetchedAt: new Date(),
          };
          this.lastFetchedTimestamp = now;
          this.logger.log(`Fallback FX API success: 1 USD = ${ngnRate} NGN`);
          return this.cachedRate;
        }
      }
    } catch (err: any) {
      this.logger.error(`Fallback FX API failed: ${err.message}. Reverting to historical DB snapshot...`);
    }

    // Revert to any historical DB snapshot
    try {
      const [lastDbRate] = await this.db
        .select()
        .from(billingExchangeRates)
        .orderBy(desc(billingExchangeRates.fetchedAt))
        .limit(1);

      if (lastDbRate) {
        this.cachedRate = {
          rate: Number(lastDbRate.usdToNgn),
          rateId: lastDbRate.id,
          source: 'stale_fallback',
          fetchedAt: new Date(lastDbRate.fetchedAt),
        };
        this.lastFetchedTimestamp = now;
        this.logger.warn(`Using last historical DB FX rate: 1 USD = ${this.cachedRate.rate} NGN`);
        return this.cachedRate;
      }
    } catch (err: any) {
      this.logger.error(`Failed to read historical DB rate: ${err.message}`);
    }

    // Hardcoded fallback as last resort
    this.logger.error(`EMERGENCY: Using hardcoded fallback rate: 1 USD = ${FX_HARDCODED_FALLBACK_RATE} NGN`);
    const emergencyRecord = await this.saveRateToDatabase(
      FX_HARDCODED_FALLBACK_RATE,
      'stale_fallback',
      null,
      { reason: 'Network and DB historical rates unreachable' },
    );

    this.cachedRate = {
      rate: FX_HARDCODED_FALLBACK_RATE,
      rateId: emergencyRecord.id,
      source: 'stale_fallback',
      fetchedAt: new Date(),
    };
    this.lastFetchedTimestamp = now;
    return this.cachedRate;
  }

  /**
   * Convert USD cents to NGN kobo and decimal amount
   */
  async convertUsdCentsToNgn(usdCents: number, specificRate?: number): Promise<{
    usdCents: number;
    ngnKobo: number;
    ngnAmount: number;
    rate: number;
    rateId: string;
  }> {
    const fx = await this.getUsdToNgnRate();
    const effectiveRate = specificRate && specificRate > 0 ? specificRate : fx.rate;
    const ngnKobo = Math.round(usdCents * effectiveRate);
    const ngnAmount = Math.round((ngnKobo / 100) * 100) / 100;

    return {
      usdCents,
      ngnKobo,
      ngnAmount,
      rate: effectiveRate,
      rateId: fx.rateId,
    };
  }

  /**
   * Convert NGN kobo to USD cents
   */
  async convertNgnKoboToUsdCents(ngnKobo: number, specificRate?: number): Promise<{
    ngnKobo: number;
    usdCents: number;
    usdAmount: number;
    rate: number;
    rateId: string;
  }> {
    const fx = await this.getUsdToNgnRate();
    const effectiveRate = specificRate && specificRate > 0 ? specificRate : fx.rate;
    const usdCents = Math.round(ngnKobo / effectiveRate);
    const usdAmount = Math.round((usdCents / 100) * 100) / 100;

    return {
      ngnKobo,
      usdCents,
      usdAmount,
      rate: effectiveRate,
      rateId: fx.rateId,
    };
  }

  /**
   * Save an exchange rate snapshot to billing_exchange_rates table
   */
  private async saveRateToDatabase(
    rate: number,
    source: 'frankfurter' | 'exchangerate_api' | 'stale_fallback',
    rawMain: any,
    rawFallback: any,
  ) {
    const [row] = await this.db
      .insert(billingExchangeRates)
      .values({
        usdToNgn: rate.toFixed(6),
        source,
        rawMainResponse: rawMain,
        rawFallbackResponse: rawFallback,
        fetchedAt: new Date(),
      })
      .returning();
    return row;
  }

  /**
   * Get exchange rate audit history
   */
  async getHistory(limit = 30) {
    return this.db
      .select()
      .from(billingExchangeRates)
      .orderBy(desc(billingExchangeRates.fetchedAt))
      .limit(limit);
  }
}
