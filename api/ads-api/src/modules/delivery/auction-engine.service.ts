import * as crypto from 'crypto';
import {
  DailySchedule,
  legacySchedule,
  scheduleMatches,
  validateSchedule,
} from '../campaigns/daily-schedule';
import { Injectable, Logger } from '@nestjs/common';
import {
  auctionScoreMicros,
  DEFAULT_AUCTION_POLICY_VERSION,
  deterministicTieDigest,
  eventPriceNanos,
  isBidAboveModelFloor,
  NANOS_PER_USD_CENT,
  reservePriceMicrosForModel,
} from './pricing-contract';

export type BidderGroupingMode = 'advertiser' | 'campaign';

export type ExclusionReasonCode =
  | 'INVALID_PRICING_VERSION'
  | 'CAMPAIGN_NOT_SERVING_ELIGIBLE'
  | 'INSUFFICIENT_BUDGET'
  | 'INSUFFICIENT_AVAILABLE_EXPOSURE'
  | 'BELOW_MODEL_BID_FLOOR'
  | 'INVALID_BID_VALUE'
  | 'CAMPAIGN_NOT_STARTED'
  | 'CAMPAIGN_ENDED'
  | 'HOURLY_PACING_EXHAUSTED'
  | 'FREQUENCY_CAP_REACHED'
  | 'SLOT_FORMAT_MISMATCH'
  | 'CATEGORY_DISALLOWED'
  | 'DEVICE_MISMATCH'
  | 'COUNTRY_MISMATCH'
  | 'STATE_MISMATCH'
  | 'CITY_MISMATCH'
  | 'SCHEDULE_MISMATCH'
  | 'INVALID_SCHEDULE'
  | 'SAME_BIDDER_SECONDARY_CREATIVE';

export interface AuctionCandidate {
  campaignId: string;
  creativeId: string;
  ownerId?: string | null;
  category?: string | null;
  status?: string | null;
  moderationStatus?: string | null;
  creativeModerationStatus?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
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
  /** Optional active reserved nanos from concurrent open opportunities */
  activeReservedNanos?: bigint;
  hourlyPacingUsdCents?: number | null;
  currentHourSpendUsdCents?: number | null;
  frequencyCapPerDay?: number | null;
  viewerDailyImpressions?: number | null;
  targetCountries?: string[] | null;
  targetStates?: string[] | null;
  targetCities?: string[] | null;
  targetDevices?: string[] | null;
  targetHours?: number[] | null;
  schedule?: DailySchedule;
  scheduleValidated?: boolean;
  format: string;
}

export interface AuctionResolutionContext {
  slotHandle: string;
  requestId?: string;
  tieSeed?: string;
  policyVersion?: string;
  bidderGroupingMode?: BidderGroupingMode;
  slotAllowedFormats?: string[];
  promoterAllowedCategories?: string[];
  clientIp?: string;
  clientGeoCountry?: string;
  clientGeoRegion?: string;
  clientGeoCity?: string;
  clientDevice?: 'desktop' | 'android' | 'ios' | 'tablet';
  requestedAt?: Date;
}

export interface EvaluatedCandidateAudit {
  campaignId: string;
  creativeId: string;
  bidderGroupKey: string;
  pricingModel: 'cpm' | 'cpc';
  bidUsdCents: number;
  scoreMicros: number;
  tieDigest: string;
}

export interface ExcludedCandidateAudit {
  campaignId: string;
  creativeId: string;
  reasonCode: ExclusionReasonCode;
}

export interface AuctionDecisionSnapshot {
  requestId: string;
  slotHandle: string;
  policyVersion: string;
  bidderGroupingMode: BidderGroupingMode;
  tieSeed: string;
  candidateCount: number;
  eligibleGroupCount: number;
  evaluatedCandidates: EvaluatedCandidateAudit[];
  excludedCandidates: ExcludedCandidateAudit[];
  winnerCampaignId: string | null;
  winnerCreativeId: string | null;
  runnerUpCampaignId: string | null;
  pricingModel: 'cpm' | 'cpc';
  clearingPriceMicros: number;
  billingPriceNanos: bigint;
  secondPriceMicros: number;
  winnerScoreMicros: number;
  previousHash: string | null;
  recordHash: string;
}

export interface AuctionResult {
  winner: AuctionCandidate;
  runnerUp: AuctionCandidate | null;
  clearingPriceMicros: number; // in 1/1,000,000 USD
  billingPriceNanos: bigint;
  secondPriceMicros: number;
  score: number;
  decisionSnapshot: AuctionDecisionSnapshot;
}

export interface OpportunityReservationRecord {
  id: string;
  opportunityId: string;
  campaignId: string;
  escrowId: string | null;
  serveId: string | null;
  pricingModel: 'cpm' | 'cpc';
  reservedNanos: bigint;
  reservedUsdCentsCeiling: number;
  state: 'HELD' | 'ISSUED' | 'CLAIMED' | 'RELEASED' | 'EXPIRED';
  isSimulated: boolean;
  expiresAt: Date;
  claimedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
}

@Injectable()
export class AuctionEngineService {
  private readonly logger = new Logger(AuctionEngineService.name);
  private readonly simulatedReservations = new Map<
    string,
    OpportunityReservationRecord
  >();

  /**
   * Computes a canonical SHA-256 hash over an auction decision snapshot
   * for tamper-evident audit verification (`ads_auction_decisions`).
   */
  computeDecisionHash(
    payload: Omit<AuctionDecisionSnapshot, 'recordHash'>,
  ): string {
    const canonical = JSON.stringify({
      requestId: payload.requestId,
      slotHandle: payload.slotHandle,
      policyVersion: payload.policyVersion,
      bidderGroupingMode: payload.bidderGroupingMode,
      tieSeed: payload.tieSeed,
      candidateCount: payload.candidateCount,
      eligibleGroupCount: payload.eligibleGroupCount,
      evaluatedCandidates: payload.evaluatedCandidates,
      excludedCandidates: payload.excludedCandidates,
      winnerCampaignId: payload.winnerCampaignId,
      winnerCreativeId: payload.winnerCreativeId,
      runnerUpCampaignId: payload.runnerUpCampaignId,
      pricingModel: payload.pricingModel,
      clearingPriceMicros: payload.clearingPriceMicros,
      billingPriceNanos: payload.billingPriceNanos.toString(),
      secondPriceMicros: payload.secondPriceMicros,
      winnerScoreMicros: payload.winnerScoreMicros,
      previousHash: payload.previousHash ?? null,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Verifies tamper-evidence of a stored AuctionDecisionSnapshot.
   */
  verifyDecisionSnapshotIntegrity(snapshot: AuctionDecisionSnapshot): boolean {
    const expected = this.computeDecisionHash(snapshot);
    return expected === snapshot.recordHash;
  }

  /**
   * Resolves dynamic second-price auction among eligible active campaigns.
   * Implements:
   * - Configurable bidder grouping ('advertiser' | 'campaign') so multiple creatives
   *   from the same bidder never compete against one another or self-inflate second price.
   * - Canonical model floors ($0.50 CPM = 500,000 micros; $0.10 CPC = 1,500,000 eCPM micros).
   * - Deterministic SHA-256 tie-breaking seeded by requestId/tieSeed.
   * - Full evaluated/excluded candidate audit trail + tamper-evident decision hash.
   */
  resolveAuction(
    candidates: AuctionCandidate[],
    context: AuctionResolutionContext,
    previousHash: string | null = null,
  ): AuctionResult | null {
    const requestId =
      context.requestId ||
      '00000000-0000-4000-8000-000000000001';
    const tieSeed = context.tieSeed || `${requestId}:${context.slotHandle}`;
    const policyVersion =
      context.policyVersion || DEFAULT_AUCTION_POLICY_VERSION;
    const bidderGroupingMode: BidderGroupingMode =
      context.bidderGroupingMode || 'advertiser';

    if (!candidates || candidates.length === 0) {
      return null;
    }

    const now = context.requestedAt || new Date();
    const excludedCandidates: ExcludedCandidateAudit[] = [];
    const eligibleRaw: AuctionCandidate[] = [];

    // 1. Deterministic Eligibility Filtering with explicit reason codes
    for (const cand of candidates) {
      if (cand.pricingVersion !== 2) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'INVALID_PRICING_VERSION',
        });
        continue;
      }

      if (
        (cand.status && cand.status !== 'active') ||
        (cand.moderationStatus && cand.moderationStatus !== 'approved') ||
        (cand.creativeModerationStatus &&
          cand.creativeModerationStatus !== 'approved')
      ) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'CAMPAIGN_NOT_SERVING_ELIGIBLE',
        });
        continue;
      }

      if (cand.remainingBudgetUsdCents <= 0) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'INSUFFICIENT_BUDGET',
        });
        continue;
      }

      if (
        ![cand.costPerImpressionUsdCents, cand.costPerClickUsdCents].every(
          (value) =>
            Number.isSafeInteger(value) && value > 0 && value <= 2147483647,
        )
      ) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'INVALID_BID_VALUE',
        });
        continue;
      }

      const activeBidCents =
        cand.pricingModel === 'cpm'
          ? cand.costPerImpressionUsdCents
          : cand.costPerClickUsdCents;

      if (!isBidAboveModelFloor(cand.pricingModel, activeBidCents)) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'BELOW_MODEL_BID_FLOOR',
        });
        continue;
      }

      // Check available funded exposure against active concurrent reservations
      const candScoreMicros = auctionScoreMicros(
        cand.pricingModel,
        activeBidCents,
      );
      const maxEventLiabilityNanos = eventPriceNanos(
        cand.pricingModel,
        candScoreMicros,
      );
      const totalRemainingNanos =
        BigInt(cand.remainingBudgetUsdCents) * NANOS_PER_USD_CENT;
      const reservedNanos =
        cand.activeReservedNanos ??
        this.getActiveSimulatedReservedNanos(cand.campaignId, now);

      if (totalRemainingNanos - reservedNanos < maxEventLiabilityNanos) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'INSUFFICIENT_AVAILABLE_EXPOSURE',
        });
        continue;
      }

      // Campaign start / end window checks
      if (cand.startsAt) {
        const startsAtDate =
          cand.startsAt instanceof Date
            ? cand.startsAt
            : new Date(cand.startsAt);
        if (
          !Number.isNaN(startsAtDate.getTime()) &&
          now.getTime() < startsAtDate.getTime()
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'CAMPAIGN_NOT_STARTED',
          });
          continue;
        }
      }

      if (cand.endsAt) {
        const endsAtDate =
          cand.endsAt instanceof Date ? cand.endsAt : new Date(cand.endsAt);
        if (
          !Number.isNaN(endsAtDate.getTime()) &&
          now.getTime() > endsAtDate.getTime()
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'CAMPAIGN_ENDED',
          });
          continue;
        }
      }

      // Hourly pacing check
      if (
        cand.hourlyPacingUsdCents != null &&
        cand.hourlyPacingUsdCents > 0 &&
        cand.currentHourSpendUsdCents != null &&
        cand.currentHourSpendUsdCents >= cand.hourlyPacingUsdCents
      ) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'HOURLY_PACING_EXHAUSTED',
        });
        continue;
      }

      // Daily frequency cap check
      if (
        cand.frequencyCapPerDay != null &&
        cand.frequencyCapPerDay > 0 &&
        cand.viewerDailyImpressions != null &&
        cand.viewerDailyImpressions >= cand.frequencyCapPerDay
      ) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'FREQUENCY_CAP_REACHED',
        });
        continue;
      }

      // Slot format compatibility
      if (
        context.slotAllowedFormats &&
        context.slotAllowedFormats.length > 0 &&
        !context.slotAllowedFormats
          .map((f) => f.toLowerCase())
          .includes(cand.format.toLowerCase())
      ) {
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'SLOT_FORMAT_MISMATCH',
        });
        continue;
      }

      // Promoter / website allowed category filter
      if (
        context.promoterAllowedCategories &&
        context.promoterAllowedCategories.length > 0 &&
        cand.category
      ) {
        const normalizedAllowed = context.promoterAllowedCategories.map((c) =>
          c.toLowerCase().trim(),
        );
        if (!normalizedAllowed.includes(cand.category.toLowerCase().trim())) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'CATEGORY_DISALLOWED',
          });
          continue;
        }
      }

      // Device targeting filter
      if (cand.targetDevices && cand.targetDevices.length > 0) {
        if (
          !context.clientDevice ||
          !cand.targetDevices.includes(context.clientDevice)
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'DEVICE_MISMATCH',
          });
          continue;
        }
      }

      // Geo-country targeting filter
      if (cand.targetCountries && cand.targetCountries.length > 0) {
        if (
          !context.clientGeoCountry ||
          !cand.targetCountries.includes(context.clientGeoCountry)
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'COUNTRY_MISMATCH',
          });
          continue;
        }
      }

      // Geo-state targeting filter
      if (cand.targetStates && cand.targetStates.length > 0) {
        if (
          !context.clientGeoRegion ||
          !cand.targetStates.some(
            (state) =>
              state.toUpperCase() === context.clientGeoRegion!.toUpperCase() ||
              state
                .toUpperCase()
                .endsWith(`-${context.clientGeoRegion!.toUpperCase()}`) ||
              context
                .clientGeoRegion!.toUpperCase()
                .endsWith(`-${state.toUpperCase()}`),
          )
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'STATE_MISMATCH',
          });
          continue;
        }
      }

      // City targeting requires a trusted canonical city from the edge
      if (cand.targetCities && cand.targetCities.length > 0) {
        if (
          !context.clientGeoCity ||
          !cand.targetCities.includes(context.clientGeoCity)
        ) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'CITY_MISMATCH',
          });
          continue;
        }
      }

      try {
        const schedule = cand.schedule
          ? cand.scheduleValidated
            ? cand.schedule
            : validateSchedule(cand.schedule)
          : legacySchedule(cand.targetHours);
        if (!scheduleMatches(schedule, now)) {
          excludedCandidates.push({
            campaignId: cand.campaignId,
            creativeId: cand.creativeId,
            reasonCode: 'SCHEDULE_MISMATCH',
          });
          continue;
        }
      } catch {
        this.logger.warn('Invalid daily schedule excluded from auction');
        excludedCandidates.push({
          campaignId: cand.campaignId,
          creativeId: cand.creativeId,
          reasonCode: 'INVALID_SCHEDULE',
        });
        continue;
      }

      eligibleRaw.push(cand);
    }

    if (eligibleRaw.length === 0) {
      return null;
    }

    // 2. Score each eligible candidate and compute deterministic tie digest
    const scoredAll = eligibleRaw.map((candidate) => {
      const bidUsdCents =
        candidate.pricingModel === 'cpm'
          ? candidate.costPerImpressionUsdCents
          : candidate.costPerClickUsdCents;
      const score = auctionScoreMicros(candidate.pricingModel, bidUsdCents);
      const bidderGroupKey =
        bidderGroupingMode === 'advertiser' && candidate.ownerId
          ? `owner:${candidate.ownerId}`
          : `campaign:${candidate.campaignId}`;
      const tieDigest = deterministicTieDigest(
        tieSeed,
        candidate.campaignId,
        candidate.creativeId,
      );
      return {
        candidate,
        bidUsdCents,
        score,
        bidderGroupKey,
        tieDigest,
      };
    });

    // Sort all eligible candidates deterministically:
    // 1) Highest eCPM score descending
    // 2) Deterministic SHA-256 tieDigest ascending
    // 3) campaignId + creativeId lexical fallback
    scoredAll.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.tieDigest !== b.tieDigest) {
        return a.tieDigest < b.tieDigest ? -1 : 1;
      }
      const campCmp = a.candidate.campaignId.localeCompare(
        b.candidate.campaignId,
      );
      if (campCmp !== 0) return campCmp;
      return a.candidate.creativeId.localeCompare(b.candidate.creativeId);
    });

    // 3. Bidder Grouping: select at most 1 representative creative per bidder group
    // so multiple creatives from the same campaign/advertiser never self-inflate clearing price.
    const seenGroups = new Set<string>();
    const groupedRepresentatives: typeof scoredAll = [];
    for (const item of scoredAll) {
      if (seenGroups.has(item.bidderGroupKey)) {
        excludedCandidates.push({
          campaignId: item.candidate.campaignId,
          creativeId: item.candidate.creativeId,
          reasonCode: 'SAME_BIDDER_SECONDARY_CREATIVE',
        });
        continue;
      }
      seenGroups.add(item.bidderGroupKey);
      groupedRepresentatives.push(item);
    }

    const winnerItem = groupedRepresentatives[0];
    const runnerUpItem =
      groupedRepresentatives.length > 1 ? groupedRepresentatives[1] : null;

    // 4. Second-price rule with canonical model floor:
    // Floor is $0.50 CPM (500,000 micros) for CPM winners or $0.10 CPC ($1.50 eCPM = 1,500,000 micros) for CPC winners.
    const reservePriceMicros = reservePriceMicrosForModel(
      winnerItem.candidate.pricingModel,
    );
    const secondPriceMicros = runnerUpItem
      ? runnerUpItem.score + 1
      : reservePriceMicros;
    const clearingPriceMicros = Math.min(
      winnerItem.score,
      Math.max(reservePriceMicros, secondPriceMicros),
    );
    const billingPriceNanos = eventPriceNanos(
      winnerItem.candidate.pricingModel,
      clearingPriceMicros,
    );

    const evaluatedCandidates: EvaluatedCandidateAudit[] =
      groupedRepresentatives.map((item) => ({
        campaignId: item.candidate.campaignId,
        creativeId: item.candidate.creativeId,
        bidderGroupKey: item.bidderGroupKey,
        pricingModel: item.candidate.pricingModel,
        bidUsdCents: item.bidUsdCents,
        scoreMicros: item.score,
        tieDigest: item.tieDigest,
      }));

    const snapshotDraft: Omit<AuctionDecisionSnapshot, 'recordHash'> = {
      requestId,
      slotHandle: context.slotHandle,
      policyVersion,
      bidderGroupingMode,
      tieSeed,
      candidateCount: candidates.length,
      eligibleGroupCount: groupedRepresentatives.length,
      evaluatedCandidates,
      excludedCandidates,
      winnerCampaignId: winnerItem.candidate.campaignId,
      winnerCreativeId: winnerItem.candidate.creativeId,
      runnerUpCampaignId: runnerUpItem
        ? runnerUpItem.candidate.campaignId
        : null,
      pricingModel: winnerItem.candidate.pricingModel,
      clearingPriceMicros,
      billingPriceNanos,
      secondPriceMicros,
      winnerScoreMicros: winnerItem.score,
      previousHash,
    };

    const decisionSnapshot: AuctionDecisionSnapshot = {
      ...snapshotDraft,
      recordHash: this.computeDecisionHash(snapshotDraft),
    };

    return {
      winner: winnerItem.candidate,
      runnerUp: runnerUpItem ? runnerUpItem.candidate : null,
      clearingPriceMicros,
      billingPriceNanos,
      secondPriceMicros,
      score: winnerItem.score,
      decisionSnapshot,
    };
  }

  /**
   * Deterministically replays a recorded auction decision from its candidate inputs
   * and context, verifying that winner, runner-up, clearingPriceMicros, billingPriceNanos,
   * and recordHash match identically.
   */
  replayAuctionDecision(
    candidates: AuctionCandidate[],
    context: AuctionResolutionContext,
    expectedSnapshot: AuctionDecisionSnapshot,
  ): {
    matches: boolean;
    replayedResult: AuctionResult | null;
    mismatches: string[];
  } {
    const replayed = this.resolveAuction(
      candidates,
      {
        ...context,
        requestId: expectedSnapshot.requestId,
        tieSeed: expectedSnapshot.tieSeed,
        policyVersion: expectedSnapshot.policyVersion,
        bidderGroupingMode: expectedSnapshot.bidderGroupingMode,
      },
      expectedSnapshot.previousHash,
    );

    const mismatches: string[] = [];
    if (!replayed) {
      if (expectedSnapshot.winnerCampaignId !== null) {
        mismatches.push('Expected a winner, but replay produced no_fill');
      }
      return {
        matches: mismatches.length === 0,
        replayedResult: null,
        mismatches,
      };
    }

    if (
      replayed.decisionSnapshot.winnerCampaignId !==
      expectedSnapshot.winnerCampaignId
    ) {
      mismatches.push(
        `winnerCampaignId mismatch: expected ${expectedSnapshot.winnerCampaignId}, got ${replayed.decisionSnapshot.winnerCampaignId}`,
      );
    }
    if (
      replayed.decisionSnapshot.winnerCreativeId !==
      expectedSnapshot.winnerCreativeId
    ) {
      mismatches.push(
        `winnerCreativeId mismatch: expected ${expectedSnapshot.winnerCreativeId}, got ${replayed.decisionSnapshot.winnerCreativeId}`,
      );
    }
    if (
      replayed.decisionSnapshot.clearingPriceMicros !==
      expectedSnapshot.clearingPriceMicros
    ) {
      mismatches.push(
        `clearingPriceMicros mismatch: expected ${expectedSnapshot.clearingPriceMicros}, got ${replayed.decisionSnapshot.clearingPriceMicros}`,
      );
    }
    if (
      replayed.decisionSnapshot.billingPriceNanos !==
      expectedSnapshot.billingPriceNanos
    ) {
      mismatches.push(
        `billingPriceNanos mismatch: expected ${expectedSnapshot.billingPriceNanos.toString()}, got ${replayed.decisionSnapshot.billingPriceNanos.toString()}`,
      );
    }
    if (
      replayed.decisionSnapshot.recordHash !== expectedSnapshot.recordHash
    ) {
      mismatches.push(
        `recordHash mismatch: expected ${expectedSnapshot.recordHash}, got ${replayed.decisionSnapshot.recordHash}`,
      );
    }

    return {
      matches: mismatches.length === 0,
      replayedResult: replayed,
      mismatches,
    };
  }

  /**
   * Returns total active simulated reserved nanos for a campaign, automatically
   * expiring stale holds past their expiresAt timestamp.
   */
  getActiveSimulatedReservedNanos(
    campaignId: string,
    now: Date = new Date(),
  ): bigint {
    this.expireStaleSimulatedReservations(now);
    let total = 0n;
    for (const res of this.simulatedReservations.values()) {
      if (
        res.campaignId === campaignId &&
        (res.state === 'HELD' || res.state === 'ISSUED')
      ) {
        total += res.reservedNanos;
      }
    }
    return total;
  }

  /**
   * Reserves per-opportunity funded exposure in isolated simulated mode (or in-memory ledger)
   * so concurrent auctions cannot issue unbacked payable tokens beyond campaign remaining budget.
   */
  reserveSimulatedOpportunityExposure(params: {
    opportunityId: string;
    campaignId: string;
    remainingBudgetUsdCents: number;
    pricingModel: 'cpm' | 'cpc';
    reservedNanos: bigint;
    escrowId?: string | null;
    serveId?: string | null;
    ttlMs?: number;
    now?: Date;
  }): OpportunityReservationRecord {
    const now = params.now || new Date();
    this.expireStaleSimulatedReservations(now);

    const existing = this.simulatedReservations.get(params.opportunityId);
    if (existing) {
      return existing;
    }

    if (params.reservedNanos <= 0n) {
      throw new RangeError('Reservation amount in nanos must be positive');
    }

    const totalRemainingNanos =
      BigInt(params.remainingBudgetUsdCents) * NANOS_PER_USD_CENT;
    const currentlyReserved = this.getActiveSimulatedReservedNanos(
      params.campaignId,
      now,
    );

    if (currentlyReserved + params.reservedNanos > totalRemainingNanos) {
      throw new Error(
        `INSUFFICIENT_AVAILABLE_EXPOSURE: campaign ${params.campaignId} has ${totalRemainingNanos - currentlyReserved} nanos unreserved, cannot reserve ${params.reservedNanos} nanos`,
      );
    }

    const ttlMs = params.ttlMs ?? 15 * 60 * 1000; // 15-minute payable window
    const reservedUsdCentsCeiling = Number(
      (params.reservedNanos + NANOS_PER_USD_CENT - 1n) / NANOS_PER_USD_CENT,
    );

    const record: OpportunityReservationRecord = {
      id: crypto.randomUUID(),
      opportunityId: params.opportunityId,
      campaignId: params.campaignId,
      escrowId: params.escrowId ?? null,
      serveId: params.serveId ?? null,
      pricingModel: params.pricingModel,
      reservedNanos: params.reservedNanos,
      reservedUsdCentsCeiling,
      state: params.serveId ? 'ISSUED' : 'HELD',
      isSimulated: true,
      expiresAt: new Date(now.getTime() + ttlMs),
      claimedAt: null,
      releasedAt: null,
      releaseReason: null,
    };

    this.simulatedReservations.set(params.opportunityId, record);
    return record;
  }

  /**
   * Transitions a held/issued reservation to CLAIMED when a valid payable event arrives
   * within the 15-minute payable window. Idempotent for duplicate claims on the same opportunityId.
   */
  claimSimulatedOpportunityExposure(
    opportunityId: string,
    now: Date = new Date(),
  ): OpportunityReservationRecord {
    this.expireStaleSimulatedReservations(now);
    const record = this.simulatedReservations.get(opportunityId);
    if (!record) {
      throw new Error(`Opportunity reservation ${opportunityId} not found`);
    }
    if (record.state === 'CLAIMED') {
      return record;
    }
    if (record.state === 'EXPIRED' || record.state === 'RELEASED') {
      throw new Error(
        `Opportunity reservation ${opportunityId} cannot be claimed from state ${record.state}`,
      );
    }
    record.state = 'CLAIMED';
    record.claimedAt = now;
    return record;
  }

  /**
   * Releases an unclaimed reservation (e.g. invalidated GIVT/SIVT event or auction rollback).
   */
  releaseSimulatedOpportunityExposure(
    opportunityId: string,
    reason: string,
    now: Date = new Date(),
  ): OpportunityReservationRecord | null {
    const record = this.simulatedReservations.get(opportunityId);
    if (!record) return null;
    if (record.state === 'CLAIMED') {
      throw new Error(
        `Cannot release already CLAIMED reservation ${opportunityId}`,
      );
    }
    record.state = 'RELEASED';
    record.releasedAt = now;
    record.releaseReason = reason;
    return record;
  }

  /**
   * Sweeps and expires any HELD/ISSUED simulated reservations past their expiresAt window.
   */
  expireStaleSimulatedReservations(now: Date = new Date()): number {
    let expiredCount = 0;
    for (const record of this.simulatedReservations.values()) {
      if (
        (record.state === 'HELD' || record.state === 'ISSUED') &&
        now.getTime() >= record.expiresAt.getTime()
      ) {
        record.state = 'EXPIRED';
        record.releasedAt = now;
        record.releaseReason = 'TTL_EXPIRED';
        expiredCount++;
      }
    }
    return expiredCount;
  }
}
