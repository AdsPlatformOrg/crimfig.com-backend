import { Injectable, Logger } from '@nestjs/common';
import * as schema from '@crimfig/database/schema';

export interface AuctionCandidate {
  campaignId: string;
  creativeId: string;
  headline: string;
  bodyText?: string | null;
  ctaText?: string | null;
  imageUrl?: string | null;
  destinationUrl: string;
  pricingModel: 'cpm' | 'cpc';
  costPerImpressionUsdCents: number;
  costPerClickUsdCents: number;
  remainingBudgetUsdCents: number;
  hourlyPacingUsdCents?: number | null;
  targetCountries?: string[] | null;
  targetStates?: string[] | null;
  targetDevices?: string[] | null;
  targetHours?: number[] | null;
  format: string;
}

export interface AuctionResolutionContext {
  slotHandle: string;
  promoterAllowedCategories?: string[];
  clientIp?: string;
  clientGeoCountry?: string;
  clientGeoRegion?: string;
  clientDevice?: 'desktop' | 'android' | 'ios' | 'tablet';
  requestedAt?: Date;
}

export interface AuctionResult {
  winner: AuctionCandidate;
  clearingPriceMicros: number; // in 1/1,000,000 USD
  secondPriceMicros: number;
  score: number;
}

@Injectable()
export class AuctionEngineService {
  private readonly logger = new Logger(AuctionEngineService.name);

  /**
   * Resolves dynamic second-price auction among eligible active campaigns
   */
  resolveAuction(
    candidates: AuctionCandidate[],
    context: AuctionResolutionContext,
  ): AuctionResult | null {
    if (!candidates || candidates.length === 0) {
      return null;
    }

    const now = context.requestedAt || new Date();
    const currentHourUtc1 = (now.getUTCHours() + 1) % 24; // WAT (UTC+1, Nigeria)

    // 1. Eligibility Filtering
    const eligible = candidates.filter((cand) => {
      // Must have positive remaining budget
      if (cand.remainingBudgetUsdCents <= 0) return false;

      // Device targeting filter
      if (cand.targetDevices && cand.targetDevices.length > 0 && context.clientDevice) {
        if (!cand.targetDevices.includes(context.clientDevice)) {
          return false;
        }
      }

      // Geo-country targeting filter
      if (cand.targetCountries && cand.targetCountries.length > 0 && context.clientGeoCountry) {
        if (!cand.targetCountries.includes(context.clientGeoCountry)) {
          return false;
        }
      }

      // Geo-state targeting filter (e.g. Lagos, Abuja)
      if (cand.targetStates && cand.targetStates.length > 0 && context.clientGeoRegion) {
        if (!cand.targetStates.includes(context.clientGeoRegion)) {
          return false;
        }
      }

      // Day-parting hour filter (WAT)
      if (cand.targetHours && cand.targetHours.length > 0) {
        if (!cand.targetHours.includes(currentHourUtc1)) {
          return false;
        }
      }

      return true;
    });

    if (eligible.length === 0) {
      return null;
    }

    // 2. eCPM Scoring & Normalization
    // CPM: bid in cents * 10 = eCPM in micros
    // CPC: bid in cents * expected CTR (1.5% default) * 1000
    const scored = eligible.map((cand) => {
      let eCpmMicros = 0;
      if (cand.pricingModel === 'cpm') {
        eCpmMicros = cand.costPerImpressionUsdCents * 10000;
      } else {
        // Assume default baseline CTR of 1.5%
        const expectedCtr = 0.015;
        eCpmMicros = cand.costPerClickUsdCents * expectedCtr * 10000;
      }

      return {
        candidate: cand,
        score: Math.max(100, Math.round(eCpmMicros)),
      };
    });

    // Sort descending by highest effective CPM score
    scored.sort((a, b) => b.score - a.score);

    const winnerItem = scored[0];
    const runnerUpItem = scored.length > 1 ? scored[1] : null;

    // Second-price rule: Runner-up score + 1 micro (floor at 100 micros = $0.0001)
    const reservePriceMicros = 100;
    const secondPriceMicros = runnerUpItem ? runnerUpItem.score + 1 : reservePriceMicros;
    const clearingPriceMicros = Math.min(winnerItem.score, Math.max(reservePriceMicros, secondPriceMicros));

    return {
      winner: winnerItem.candidate,
      clearingPriceMicros,
      secondPriceMicros,
      score: winnerItem.score,
    };
  }
}
