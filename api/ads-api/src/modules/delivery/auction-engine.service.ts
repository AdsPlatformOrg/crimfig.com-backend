import { Injectable, Logger } from '@nestjs/common';
import { auctionScoreMicros, eventPriceNanos } from './pricing-contract';

export interface AuctionCandidate {
  campaignId: string;
  creativeId: string;
  headline: string;
  bodyText?: string | null;
  ctaText?: string | null;
  imageUrl?: string | null;
  destinationUrl: string;
  pricingModel: 'cpm' | 'cpc';
  pricingVersion: number;
  costPerImpressionUsdCents: number;
  costPerClickUsdCents: number;
  remainingBudgetUsdCents: number;
  hourlyPacingUsdCents?: number | null;
  targetCountries?: string[] | null;
  targetStates?: string[] | null;
  targetCities?: string[] | null;
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
  clientGeoCity?: string;
  clientDevice?: 'desktop' | 'android' | 'ios' | 'tablet';
  requestedAt?: Date;
}

export interface AuctionResult {
  winner: AuctionCandidate;
  clearingPriceMicros: number; // in 1/1,000,000 USD
  billingPriceNanos: bigint;
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
      if (cand.pricingVersion !== 2 || cand.remainingBudgetUsdCents <= 0) return false;
      if (![cand.costPerImpressionUsdCents, cand.costPerClickUsdCents].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) return false;

      // Device targeting filter
      if (cand.targetDevices && cand.targetDevices.length > 0) {
        if (!context.clientDevice || !cand.targetDevices.includes(context.clientDevice)) {
          return false;
        }
      }

      // Geo-country targeting filter
      if (cand.targetCountries && cand.targetCountries.length > 0) {
        if (!context.clientGeoCountry || !cand.targetCountries.includes(context.clientGeoCountry)) {
          return false;
        }
      }

      // Geo-state targeting filter (e.g. Lagos, Abuja)
      if (cand.targetStates && cand.targetStates.length > 0) {
        if (!context.clientGeoRegion || !cand.targetStates.some((state) =>
          state.toUpperCase() === context.clientGeoRegion!.toUpperCase() ||
          state.toUpperCase().endsWith(`-${context.clientGeoRegion!.toUpperCase()}`) ||
          context.clientGeoRegion!.toUpperCase().endsWith(`-${state.toUpperCase()}`))) {
          return false;
        }
      }

      // City targeting requires a trusted canonical city from the edge.
      if (cand.targetCities && cand.targetCities.length > 0) {
        if (!context.clientGeoCity || !cand.targetCities.includes(context.clientGeoCity)) {
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

    // Standard CPM cents per 1,000 impressions; CPC normalized at versioned 1.5% ranking CTR.
    const scored = eligible.map(candidate => ({ candidate,
      score: auctionScoreMicros(candidate.pricingModel, candidate.pricingModel === 'cpm' ? candidate.costPerImpressionUsdCents : candidate.costPerClickUsdCents),
    }));

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
      billingPriceNanos: eventPriceNanos(winnerItem.candidate.pricingModel, clearingPriceMicros),
      secondPriceMicros,
      score: winnerItem.score,
    };
  }
}
