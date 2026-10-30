import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  FRAUD_CLICK_DEDUPE_WINDOW_MS,
  FRAUD_MIN_VIEW_TO_CLICK_MS,
  FRAUD_MAX_HOURLY_IP_CLICKS,
  FRAUD_MAX_HOURLY_IP_IMPRESSIONS,
  KNOWN_BOT_USER_AGENTS,
  FRAUD_REASON_CODES,
} from './fraud.constants';

export type IvtCategory = 'unclassified' | 'GIVT' | 'SIVT';
export type TrafficRiskStatus =
  | 'normal'
  | 'suspicious'
  | 'high_risk'
  | 'confirmed_fraud';
export type AssessmentStatus =
  | 'provisional'
  | 'validated'
  | 'suspicious'
  | 'invalidated'
  | 'unknown';
export type FinancialEligibility =
  | 'pending'
  | 'eligible'
  | 'quarantined'
  | 'invalid';

export interface ClickValidationParams {
  placementId: string;
  serveId?: string;
  clientIp?: string;
  userAgent?: string;
  referrer?: string;
  tokenTimestampMs?: number;
}

export interface ImpressionValidationParams {
  placementId: string;
  serveId?: string;
  clientIp?: string;
  userAgent?: string;
  referrer?: string;
  visibleRatio?: number;
  durationSeconds?: number;
  minDurationSeconds?: number;
  isViewableEvent?: boolean;
}

export interface SupplyRiskParams {
  slotTagId: string;
  clientIp?: string;
  userAgent?: string;
  originOrRefererHost?: string;
  registeredDomain?: string;
  trustScore?: number;
}

export interface ValidationResult {
  isValid: boolean;
  reasonCode?: string;
  ivtCategory: IvtCategory;
  assessmentStatus: AssessmentStatus;
  financialEligibility: FinancialEligibility;
  trafficRiskStatus: TrafficRiskStatus;
}

@Injectable()
export class FraudRulesService {
  private readonly logger = new Logger(FraudRulesService.name);

  // In-memory sliding window caches (mirrors Redis key pattern if Redis is detached)
  private readonly recentClicks = new Map<string, number>();
  private readonly hourlyIpImpressions = new Map<string, number[]>();
  private readonly hourlyIpClicks = new Map<string, number[]>();
  private readonly seenServeEvents = new Set<string>();

  /**
   * Keyed HMAC-SHA256 IP hash with explicit keyId for privacy-preserving
   * GIVT/SIVT evidence correlation without storing raw IP in public tables.
   */
  computeKeyedIpHash(clientIp?: string): {
    keyedIpHash: string;
    keyId: string;
  } {
    const keyId = process.env.ADS_EVIDENCE_HASH_KEY_ID || 'evkey_2026_10';
    const secret =
      process.env.ADS_EVIDENCE_HASH_SECRET ||
      process.env.ADS_IMPRESSION_SIGNING_KEY ||
      'crimfig_evidence_hmac_key_2026_v1';
    if (!clientIp) {
      return { keyedIpHash: 'unknown', keyId };
    }
    const keyedIpHash = crypto
      .createHmac('sha256', secret)
      .update(`${keyId}:${clientIp}`)
      .digest('hex');
    return { keyedIpHash, keyId };
  }

  /**
   * Deduplicates events per `(serveId, eventType)` so replayed network beacons
   * cannot create duplicate billable impressions or clicks.
   */
  isDuplicateServeEvent(serveId: string | undefined, eventType: string): boolean {
    if (!serveId) return false;
    const key = `${serveId}:${eventType}`;
    if (this.seenServeEvents.has(key)) {
      return true;
    }
    this.seenServeEvents.add(key);
    return false;
  }

  /**
   * Evaluates supply-time traffic risk for a slot request.
   * When traffic is suspicious or high_risk on an otherwise authorized slot,
   * DeliveryService switches to shadow serving (CrimFig House Ad, zero financial liability).
   */
  assessSupplyRequestRisk(params: SupplyRiskParams): {
    trafficRiskStatus: TrafficRiskStatus;
    ivtCategory: IvtCategory;
    reasonCode?: string;
  } {
    const ua = (params.userAgent || '').toLowerCase();
    const ip = params.clientIp || 'unknown';

    // 1. GIVT: Known crawler / headless user-agent or missing UA
    if (!ua || KNOWN_BOT_USER_AGENTS.some((bot) => ua.includes(bot))) {
      return {
        trafficRiskStatus: 'high_risk',
        ivtCategory: 'GIVT',
        reasonCode: FRAUD_REASON_CODES.BOT_UA,
      };
    }

    // 2. SIVT: Domain mismatch when origin/referer is present
    if (params.registeredDomain && params.originOrRefererHost) {
      const reg = params.registeredDomain.toLowerCase().replace(/^www\./, '');
      const actual = params.originOrRefererHost
        .toLowerCase()
        .replace(/^www\./, '');
      if (actual !== reg && !actual.endsWith(`.${reg}`)) {
        return {
          trafficRiskStatus: 'confirmed_fraud',
          ivtCategory: 'SIVT',
          reasonCode: FRAUD_REASON_CODES.DOMAIN_MISMATCH,
        };
      }
    }

    // 3. SIVT: Excessive IP request velocity on the same slot
    const now = Date.now();
    const rateKey = `rate:imp:${ip}:${params.slotTagId}`;
    const recentImps = (this.hourlyIpImpressions.get(rateKey) || []).filter(
      (ts) => now - ts < 60 * 60 * 1000,
    );
    if (recentImps.length >= FRAUD_MAX_HOURLY_IP_IMPRESSIONS) {
      return {
        trafficRiskStatus: 'suspicious',
        ivtCategory: 'SIVT',
        reasonCode: FRAUD_REASON_CODES.IP_RATE_IMP,
      };
    }

    // 4. Low promoter/website trust score triggers shadow mode
    if (params.trustScore !== undefined && params.trustScore < 40) {
      return {
        trafficRiskStatus: 'suspicious',
        ivtCategory: 'SIVT',
        reasonCode: 'LOW_TRUST_SCORE',
      };
    }

    return {
      trafficRiskStatus: 'normal',
      ivtCategory: 'unclassified',
    };
  }

  /**
   * Validate incoming ad click before recording and redirecting
   */
  validateClick(params: ClickValidationParams): ValidationResult {
    const ua = (params.userAgent || '').toLowerCase();
    const ip = params.clientIp || 'unknown';

    // 0. Duplicate (serveId, click) check
    if (this.isDuplicateServeEvent(params.serveId, 'click')) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.DUP_CLICK,
        ivtCategory: 'GIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'suspicious',
      };
    }

    // 1. GIVT: Bot & Headless User-Agent Check
    if (!ua || KNOWN_BOT_USER_AGENTS.some((bot) => ua.includes(bot))) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.BOT_UA,
        ivtCategory: 'GIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'high_risk',
      };
    }

    // 2. SIVT: Minimum View-to-Click Timing Guard (Click arriving under 300ms from impression)
    if (params.tokenTimestampMs) {
      const elapsed = Date.now() - params.tokenTimestampMs;
      if (elapsed < FRAUD_MIN_VIEW_TO_CLICK_MS) {
        return {
          isValid: false,
          reasonCode: FRAUD_REASON_CODES.FAST_CLICK,
          ivtCategory: 'SIVT',
          assessmentStatus: 'invalidated',
          financialEligibility: 'invalid',
          trafficRiskStatus: 'high_risk',
        };
      }
    }

    // 3. GIVT: Rapid Click Deduplication (Burst protection within 30s)
    const dedupeKey = `clk:${ip}:${params.placementId}`;
    const lastClickTime = this.recentClicks.get(dedupeKey);
    const now = Date.now();

    if (lastClickTime && now - lastClickTime < FRAUD_CLICK_DEDUPE_WINDOW_MS) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.DUP_CLICK,
        ivtCategory: 'GIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'suspicious',
      };
    }
    this.recentClicks.set(dedupeKey, now);

    // 4. SIVT: Hourly IP Click Rate Cap
    const ipRateKey = `rate:clk:${ip}:${params.placementId}`;
    const clickTimestamps = (this.hourlyIpClicks.get(ipRateKey) || []).filter(
      (ts) => now - ts < 60 * 60 * 1000,
    );
    if (clickTimestamps.length >= FRAUD_MAX_HOURLY_IP_CLICKS) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.IP_RATE_CLK,
        ivtCategory: 'SIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'high_risk',
      };
    }
    clickTimestamps.push(now);
    this.hourlyIpClicks.set(ipRateKey, clickTimestamps);

    return {
      isValid: true,
      ivtCategory: 'unclassified',
      assessmentStatus: 'validated',
      financialEligibility: 'eligible',
      trafficRiskStatus: 'normal',
    };
  }

  /**
   * Validate incoming impression / viewability event
   */
  validateImpression(params: ImpressionValidationParams): ValidationResult {
    const ua = (params.userAgent || '').toLowerCase();
    const ip = params.clientIp || 'unknown';
    const eventType = params.isViewableEvent
      ? 'viewable_impression'
      : 'impression';

    // 0. Duplicate (serveId, eventType) check
    if (this.isDuplicateServeEvent(params.serveId, eventType)) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.DUP_IMP,
        ivtCategory: 'GIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'suspicious',
      };
    }

    // 1. GIVT: Bot & Headless User-Agent Check
    if (!ua || KNOWN_BOT_USER_AGENTS.some((bot) => ua.includes(bot))) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.BOT_UA,
        ivtCategory: 'GIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'high_risk',
      };
    }

    // 2. GIVT: Non-finite or sub-threshold viewability telemetry
    if (params.isViewableEvent) {
      const minSec = params.minDurationSeconds ?? 1;
      if (
        typeof params.visibleRatio !== 'number' ||
        !Number.isFinite(params.visibleRatio) ||
        params.visibleRatio < 0.5 ||
        params.visibleRatio > 1 ||
        typeof params.durationSeconds !== 'number' ||
        !Number.isFinite(params.durationSeconds) ||
        params.durationSeconds < minSec ||
        params.durationSeconds > 900
      ) {
        return {
          isValid: false,
          reasonCode: 'VIEWABILITY_THRESHOLD',
          ivtCategory: 'GIVT',
          assessmentStatus: 'invalidated',
          financialEligibility: 'invalid',
          trafficRiskStatus: 'suspicious',
        };
      }
    }

    // 3. SIVT: Hourly IP Impression Cap
    const now = Date.now();
    const ipRateKey = `rate:imp:${ip}:${params.placementId}`;
    const impTimestamps = (
      this.hourlyIpImpressions.get(ipRateKey) || []
    ).filter((ts) => now - ts < 60 * 60 * 1000);
    if (impTimestamps.length >= FRAUD_MAX_HOURLY_IP_IMPRESSIONS) {
      return {
        isValid: false,
        reasonCode: FRAUD_REASON_CODES.IP_RATE_IMP,
        ivtCategory: 'SIVT',
        assessmentStatus: 'invalidated',
        financialEligibility: 'invalid',
        trafficRiskStatus: 'high_risk',
      };
    }
    impTimestamps.push(now);
    this.hourlyIpImpressions.set(ipRateKey, impTimestamps);

    return {
      isValid: true,
      ivtCategory: 'unclassified',
      assessmentStatus: params.isViewableEvent ? 'validated' : 'provisional',
      financialEligibility: params.isViewableEvent ? 'eligible' : 'pending',
      trafficRiskStatus: 'normal',
    };
  }
}
