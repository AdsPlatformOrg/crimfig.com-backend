import { Injectable, Logger } from '@nestjs/common';
import {
  FRAUD_CLICK_DEDUPE_WINDOW_MS,
  FRAUD_MIN_VIEW_TO_CLICK_MS,
  FRAUD_MAX_HOURLY_IP_CLICKS,
  FRAUD_MAX_HOURLY_IP_IMPRESSIONS,
  KNOWN_BOT_USER_AGENTS,
  FRAUD_REASON_CODES,
} from './fraud.constants';

export interface ClickValidationParams {
  placementId: string;
  clientIp?: string;
  userAgent?: string;
  referrer?: string;
  tokenTimestampMs?: number;
}

export interface ImpressionValidationParams {
  placementId: string;
  clientIp?: string;
  userAgent?: string;
  referrer?: string;
}

export interface ValidationResult {
  isValid: boolean;
  reasonCode?: string;
}

@Injectable()
export class FraudRulesService {
  private readonly logger = new Logger(FraudRulesService.name);

  // In-memory sliding window caches (mirrors Redis key pattern if Redis is detached)
  private readonly recentClicks = new Map<string, number>();
  private readonly hourlyIpImpressions = new Map<string, number[]>();
  private readonly hourlyIpClicks = new Map<string, number[]>();

  /**
   * Validate incoming ad click before recording and redirecting
   */
  validateClick(params: ClickValidationParams): ValidationResult {
    const ua = (params.userAgent || '').toLowerCase();
    const ip = params.clientIp || 'unknown';

    // 1. Bot & Headless User-Agent Check
    if (KNOWN_BOT_USER_AGENTS.some((bot) => ua.includes(bot))) {
      return { isValid: false, reasonCode: FRAUD_REASON_CODES.BOT_UA };
    }

    // 2. Minimum View-to-Click Timing Guard (Click arriving under 300ms from impression)
    if (params.tokenTimestampMs) {
      const elapsed = Date.now() - params.tokenTimestampMs;
      if (elapsed < FRAUD_MIN_VIEW_TO_CLICK_MS) {
        return { isValid: false, reasonCode: FRAUD_REASON_CODES.FAST_CLICK };
      }
    }

    // 3. Rapid Click Deduplication (Burst protection within 30s)
    const dedupeKey = `clk:${ip}:${params.placementId}`;
    const lastClickTime = this.recentClicks.get(dedupeKey);
    const now = Date.now();

    if (lastClickTime && now - lastClickTime < FRAUD_CLICK_DEDUPE_WINDOW_MS) {
      return { isValid: false, reasonCode: FRAUD_REASON_CODES.DUP_CLICK };
    }
    this.recentClicks.set(dedupeKey, now);

    // 4. Hourly IP Click Rate Cap
    const ipRateKey = `rate:clk:${ip}:${params.placementId}`;
    const clickTimestamps = (this.hourlyIpClicks.get(ipRateKey) || []).filter(
      (ts) => now - ts < 60 * 60 * 1000,
    );
    if (clickTimestamps.length >= FRAUD_MAX_HOURLY_IP_CLICKS) {
      return { isValid: false, reasonCode: FRAUD_REASON_CODES.IP_RATE_CLK };
    }
    clickTimestamps.push(now);
    this.hourlyIpClicks.set(ipRateKey, clickTimestamps);

    return { isValid: true };
  }

  /**
   * Validate incoming impression / viewability event
   */
  validateImpression(params: ImpressionValidationParams): ValidationResult {
    const ua = (params.userAgent || '').toLowerCase();
    const ip = params.clientIp || 'unknown';

    // 1. Bot & Headless User-Agent Check
    if (KNOWN_BOT_USER_AGENTS.some((bot) => ua.includes(bot))) {
      return { isValid: false, reasonCode: FRAUD_REASON_CODES.BOT_UA };
    }

    // 2. Hourly IP Impression Cap
    const now = Date.now();
    const ipRateKey = `rate:imp:${ip}:${params.placementId}`;
    const impTimestamps = (this.hourlyIpImpressions.get(ipRateKey) || []).filter(
      (ts) => now - ts < 60 * 60 * 1000,
    );
    if (impTimestamps.length >= FRAUD_MAX_HOURLY_IP_IMPRESSIONS) {
      return { isValid: false, reasonCode: FRAUD_REASON_CODES.IP_RATE_IMP };
    }
    impTimestamps.push(now);
    this.hourlyIpImpressions.set(ipRateKey, impTimestamps);

    return { isValid: true };
  }
}
