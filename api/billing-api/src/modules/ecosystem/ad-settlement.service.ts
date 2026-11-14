import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@crimfig/database/schema';
import { adEventJournalMatches, validEvidenceSignature } from '@crimfig/shared';
import { DATABASE_TOKEN } from '../database/database.module';

const CENT = 10_000_000n, MAX = 2147483647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Sole Billing-owned transaction: claim events, consume funded escrow, create 72h held earnings.
 * Neither a client impression nor a passed fast-path rule releases publisher money to a wallet.
 */
@Injectable()
export class AdSettlementService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof s>) {}

  async settle(campaignId: string, requestId: string, periodEnd: Date, eventId?: string) {
    if (!uuid.test(campaignId) || !uuid.test(requestId) || (eventId !== undefined && !uuid.test(eventId)) || !Number.isFinite(periodEnd.getTime()) || periodEnd > new Date()) {
      throw new BadRequestException('A campaign, unique settlement request and closed period are required');
    }
    // PostgreSQL UUID equality is case-insensitive; lock and receipt keys must be too.
    campaignId = campaignId.toLowerCase();
    requestId = requestId.toLowerCase();
    eventId = eventId?.toLowerCase();
    const key = `ads-settlement:v3:${campaignId}:${requestId}`;
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      // Same lock order as campaign pause/reserve/release. A paused campaign cannot be double-spent.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${campaignId}`}, 0))`);
      const [prior] = await tx.select().from(s.adsSettlementBatches).where(eq(s.adsSettlementBatches.idempotencyKey, key));
      if (prior) {
        if (prior.periodEnd.getTime() !== periodEnd.getTime() || (JSON.parse(prior.notes || "{}").eventId ?? undefined) !== eventId) throw new ConflictException('Settlement request is bound to another period');
        return { batchId: prior.id, status: prior.status, billedUsdCents: prior.totalDebitedUsdCents, replayed: true };
      }
      const [campaign] = await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id, campaignId)).for('update');
      if (!campaign) throw new NotFoundException('Campaign not found');
      // A stop blocks new serves, but still permits already funded and assessed network events to close.
      const stopped = campaign.status === 'paused' || campaign.status === 'trash';
      if (campaign.pricingVersion !== 2 || (!stopped && (campaign.status !== 'active' || campaign.moderationStatus !== 'approved'))) {
        throw new ConflictException('Campaign must have reviewed versioned pricing and active approval');
      }
      const escrows = await tx.select().from(s.adsCampaignEscrows).where(eq(s.adsCampaignEscrows.campaignId, campaignId)).for('update');
      const escrow = escrows[0];
      if (escrows.length !== 1 || escrow.userId !== campaign.advertiserId || escrow.status !== 'active' || (stopped && !escrow.releasePending) ||
        [escrow.allocatedUsdCents, escrow.consumedUsdCents, escrow.refundedUsdCents].some(value => !Number.isSafeInteger(value) || value < 0) ||
        escrow.consumedUsdCents + escrow.refundedUsdCents > escrow.allocatedUsdCents) throw new ConflictException('Escrow requires reconciliation');
      const [reservation] = await tx.select().from(s.billingTransactions).where(eq(s.billingTransactions.idempotencyKey,
        `ads-escrow:v2:${escrow.id}:reserve:${escrow.allocatedUsdCents}`));
      let reserved: any;
      try { reserved = JSON.parse(reservation?.metadata || '{}'); } catch { throw new ConflictException('Reservation proof invalid'); }
      if (!reservation || reservation.userId !== campaign.advertiserId || reservation.status !== 'completed' || reservation.type !== 'internal_debit' ||
        reservation.provider !== 'internal' || reserved.version !== 2 || reserved.kind !== 'campaign_escrow' || reserved.action !== 'reserve' ||
        reserved.campaignId !== campaignId || reserved.escrowId !== escrow.id || reserved.allocatedUsdCents !== escrow.allocatedUsdCents) {
        throw new ConflictException('A verified Billing reservation is required');
      }
      const [spendProof] = await tx.select({ cents: sql<string>`coalesce(sum(${s.billingTransactions.amountUsdCents}),0)` })
        .from(s.billingTransactions).where(and(eq(s.billingTransactions.type, 'ads_spend'), eq(s.billingTransactions.status, 'completed'),
          eq(s.billingTransactions.provider, 'internal'), sql`${s.billingTransactions.idempotencyKey} like 'ads-settlement:v3:%'`,
          sql`(${s.billingTransactions.metadata}::jsonb)->>'escrowId' = ${escrow.id}`));
      if (Number(spendProof.cents) !== escrow.consumedUsdCents) throw new ConflictException('Historical escrow consumption requires reconciliation');
      const [wallet] = await tx.select().from(s.billingWallets).where(eq(s.billingWallets.userId, campaign.advertiserId)).for('update');
      const [advertiser] = await tx.select({ status: s.users.status }).from(s.users).where(eq(s.users.id, campaign.advertiserId)).for('share');
      if (!wallet || advertiser?.status !== 'ACTIVE') throw new ConflictException('Advertiser funds unavailable');
      // Claims are selected from persisted server provenance, never caller-supplied amounts or owners.
      const opportunity = s.adsOpportunityReservations;
      const exposure = await tx.execute<{ outstanding: string; carry: string }>(sql`
        SELECT (SELECT COALESCE(SUM(reserved_nanos), 0)::text FROM ads_opportunity_reservations
          WHERE escrow_id = ${escrow.id} AND escrow_allocated_usd_cents = ${escrow.allocatedUsdCents}
            AND NOT is_simulated AND settled_at IS NULL AND state IN ('HELD','ISSUED','CLAIMED')) AS outstanding,
          (SELECT COALESCE(SUM(carry_nanos), 0)::text FROM ads_settlement_carries
          WHERE escrow_id = ${escrow.id} AND allocated_usd_cents = ${escrow.allocatedUsdCents}) AS carry
      `);
      let outstanding = BigInt(exposure.rows[0].outstanding);
      let totalCarry = BigInt(exposure.rows[0].carry);
      const fundedCapacity = BigInt(Math.min(wallet.lockedUsdCents, campaign.remainingBudgetUsdCents,
        escrow.allocatedUsdCents - escrow.consumedUsdCents - escrow.refundedUsdCents)) * CENT;
      const candidates = await tx.select({ event: s.adsInteractions, serve: s.adsServes, promoter: s.adsPromoters, placement: s.adsPlacements,
        opportunity, ownerStatus: s.users.status, cpcVisitorKey: sql<string | null>`"ads_serves"."cpc_visitor_key"` }).from(s.adsInteractions)
        .innerJoin(s.adsServes, eq(s.adsServes.id, s.adsInteractions.serveId))
        .innerJoin(s.adsPromoters, eq(s.adsPromoters.id, s.adsServes.promoterId))
        .leftJoin(s.adsPlacements, eq(s.adsPlacements.id, s.adsServes.placementId))
        .leftJoin(opportunity, eq(opportunity.id, s.adsServes.opportunityReservationId))
        .innerJoin(s.adsCreatives, eq(s.adsCreatives.id, s.adsServes.creativeId))
        .innerJoin(s.users, eq(s.users.id, s.adsPromoters.userId))
        .leftJoin(s.adsPromoterWebsites, eq(s.adsPromoterWebsites.id, sql`coalesce(${s.adsServes.websiteId}, ${s.adsPlacements.websiteId})`))
        .leftJoin(s.adsSettlementClaims, eq(s.adsSettlementClaims.serveId, s.adsServes.id))
        .where(and(eq(s.adsServes.campaignId, campaignId), eq(s.adsServes.pricingVersion, 2),
          eq(s.adsInteractions.verificationVersion, 2), eq(s.adsInteractions.isValid, true),
          eq(s.adsInteractions.promoterId, s.adsServes.promoterId),
          eq(s.adsServes.inventoryClass, 'paid'), eq(s.adsServes.deliveryMode, 'normal'),
          or(
            and(sql`${!stopped}::boolean`, isNull(s.adsServes.opportunityReservationId), eq(s.adsInteractions.placementId, s.adsServes.placementId),
              eq(s.adsPlacements.promoterId, s.adsPromoters.id), eq(s.adsPlacements.campaignId, campaignId),
              eq(s.adsPlacements.creativeId, s.adsServes.creativeId), eq(s.adsPlacements.status, 'active')),
            and(isNull(s.adsServes.placementId), isNull(s.adsInteractions.placementId),
              eq(opportunity.state, 'CLAIMED'), eq(opportunity.isSimulated, false), isNull(opportunity.settledAt),
              eq(opportunity.claimEventId, s.adsInteractions.id), eq(opportunity.serveId, s.adsServes.id),
              eq(opportunity.escrowId, escrow.id), eq(opportunity.escrowAllocatedUsdCents, escrow.allocatedUsdCents),
              sql`(SELECT outcome FROM ads_event_assessments WHERE event_id = ${s.adsInteractions.id}
                ORDER BY created_at DESC, id DESC LIMIT 1) = 'eligible'`),
          ),
          eq(s.adsCreatives.campaignId, s.adsServes.campaignId), eq(s.adsCreatives.status, 'active'), eq(s.adsCreatives.reviewStatus, 'approved'),
          eq(s.adsPromoters.isActive, true), eq(s.adsPromoters.isSuspended, false), eq(s.users.status, 'ACTIVE'), ne(s.adsPromoters.userId, campaign.advertiserId),
          sql`not exists (select 1 from billing_provider_events review where review.provider = 'paystack' and review.event_type = 'internal.ad.rejection' and review.error_message is distinct from 'review_dismissed' and review.reference like ${`internal.ad.rejection:${escrow.id}:`} || ${s.adsPromoters.id}::text || ':%')`,
          or(eq(s.adsPromoters.type, 'INDIVIDUAL'), and(eq(s.adsPromoters.type, 'WEBSITE'), eq(s.adsPromoterWebsites.promoterId, s.adsPromoters.id),
            eq(s.adsPromoterWebsites.verificationStatus, 'verified'), eq(s.adsPromoterWebsites.isActive, true), eq(s.adsPromoterWebsites.isSuspended, false))),
          or(and(eq(s.adsServes.pricingModel, 'cpm'), eq(s.adsInteractions.type, 'viewable_impression')),
            and(eq(s.adsServes.pricingModel, 'cpc'), eq(s.adsInteractions.type, 'click'))),
          sql`${s.adsInteractions.createdAt} >= ${s.adsServes.servedAt} and ${s.adsInteractions.createdAt} <= ${s.adsServes.servedAt} + interval '15 minutes'`,
          sql`${s.adsServes.servedAt} >= ${reservation.createdAt} and ${s.adsServes.billingPriceNanos} > 0`,
          lt(s.adsInteractions.createdAt, periodEnd), isNull(s.adsSettlementClaims.id),
          eventId ? and(eq(s.adsInteractions.id, eventId), eq(opportunity.claimEventId, eventId)) : undefined))
        .orderBy(asc(s.adsInteractions.createdAt), asc(s.adsInteractions.id)).limit(100);
      const now = new Date(), batchId = randomUUID();
      await tx.insert(s.adsSettlementBatches).values({ id: batchId, batchNumber: `V3-${campaignId}-${requestId}`, idempotencyKey: key,
        periodStart: candidates[0]?.event.createdAt || periodEnd, periodEnd, status: 'processing',
        notes: JSON.stringify({ version: 3, campaignId, escrowId: escrow.id, allocatedUsdCents: escrow.allocatedUsdCents,
          eventId, pricingVersion: 2, publisherPolicy: '55/30/15', commissionPaid: 0, fractionalPolicy: 'carry-within-funded-generation' }) });
      let total = 0, publisherTotal = 0, impressions = 0, clicks = 0;
      const seen = new Set<string>();
      let frequencyExcluded = false;
      for (const candidate of candidates) {
        const { event, serve, promoter, placement, opportunity: funded, ownerStatus, cpcVisitorKey } = candidate;
        if (seen.has(serve.id)) continue;
        if (event.placementId !== serve.placementId || event.promoterId !== serve.promoterId ||
          promoter.userId === campaign.advertiserId || !promoter.isActive || promoter.isSuspended || ownerStatus !== 'ACTIVE' ||
          promoter.type === 'MOBILE_APP' ||
          event.createdAt < serve.servedAt || event.createdAt.getTime() - serve.servedAt.getTime() > 900_000 ||
          serve.servedAt < reservation.createdAt || serve.billingPriceNanos <= 0n ||
          !((serve.pricingModel === 'cpm' && event.type === 'viewable_impression') || (serve.pricingModel === 'cpc' && event.type === 'click'))) continue;
        if (funded) {
          if (funded.campaignId !== campaignId || funded.creativeId !== serve.creativeId ||
            funded.promoterId !== promoter.id || funded.websiteId !== serve.websiteId || funded.websiteId !== event.websiteId ||
            funded.slotId !== serve.slotId || funded.slotId !== event.slotId || funded.submissionId !== serve.submissionId ||
            funded.contentRevision !== serve.contentRevision || funded.policyVersion !== serve.policyVersion ||
            funded.opportunityId !== serve.requestId || funded.pricingModel !== serve.pricingModel ||
            funded.reservedNanos !== serve.billingPriceNanos || event.createdAt < funded.createdAt ||
            !funded.eventDeadline || event.createdAt > funded.eventDeadline ||
            event.financialEligibility !== 'pending' || event.assessmentStatus === 'invalidated' ||
            !funded.websiteId || !funded.slotId) continue;
          const [supply] = await tx.select({ site: s.adsPromoterWebsites, slot: s.adstationSlots })
            .from(s.adstationSlots).innerJoin(s.adsPromoterWebsites, eq(s.adstationSlots.websiteId, s.adsPromoterWebsites.id))
            .where(and(eq(s.adstationSlots.id, funded.slotId), eq(s.adsPromoterWebsites.id, funded.websiteId))).for('share');
          if (!supply || supply.site.promoterId !== promoter.id || supply.slot.promoterId !== promoter.id ||
            !supply.slot.isActive || supply.slot.lifecycleStatus !== 'active' || supply.slot.installationStatus !== 'verified' ||
            !['network', 'hybrid'].includes(supply.slot.slotType) || !supply.site.isActive || supply.site.isSuspended ||
            supply.site.policyStatus !== 'approved' || supply.site.verificationStatus !== 'verified' ||
            !supply.site.verificationExpiresAt || supply.site.verificationExpiresAt <= new Date()) continue;
          const [assessment] = await tx.select().from(s.adsEventAssessments)
            .where(eq(s.adsEventAssessments.eventId, event.id))
            .orderBy(desc(s.adsEventAssessments.createdAt), desc(s.adsEventAssessments.id)).limit(1);
          if (!assessment || assessment.campaignId !== campaignId || assessment.outcome !== 'eligible' ||
            assessment.actorId === campaign.advertiserId || assessment.actorId === promoter.userId) continue;
          const { recordHash, createdAt: assessedAt, ...signed } = assessment;
          if (!validEvidenceSignature(signed, recordHash)) continue;
          const [journal] = await tx.select().from(s.adsEvidenceRecords)
            .where(eq(s.adsEvidenceRecords.eventId, event.id)).limit(1);
          if (!journal || !adEventJournalMatches(event, journal) ||
            !validEvidenceSignature({ eventId: journal.eventId, partition: journal.partition, previousHash: journal.previousHash,
              payload: journal.payload, keyId: journal.keyId }, journal.recordHash)) continue;
        } else if (promoter.type === 'WEBSITE') {
          if (!placement?.websiteId) continue;
          const [site] = await tx.select().from(s.adsPromoterWebsites).where(eq(s.adsPromoterWebsites.id, placement.websiteId)).for('share');
          if (!site || site.promoterId !== promoter.id || site.verificationStatus !== 'verified' || !site.isActive || site.isSuspended) continue;
        }
        if (event.type === 'click' && cpcVisitorKey !== null) {
          // The campaign lock serializes this check with claims from other workers.
          // Check both directions in event time because older events can settle late.
          const { rows } = await tx.execute(sql`
            SELECT 1 FROM ads_serves prior
            JOIN ads_settlement_claims claim ON claim.serve_id = prior.id
            JOIN ads_interactions click ON click.id = claim.interaction_id
            JOIN ads_interactions candidate ON candidate.id = ${event.id}
            WHERE prior.campaign_id = ${campaignId}
              AND prior.pricing_model = 'cpc' AND prior.cpc_visitor_key = ${cpcVisitorKey}
              AND click.created_at > candidate.created_at - interval '2160 hours'
              AND click.created_at < candidate.created_at + interval '2160 hours'
            LIMIT 1
          `);
          if (rows.length) {
            frequencyExcluded = true;
            if (funded) {
              await tx.update(opportunity).set({
                state: 'RELEASED', releaseReason: 'CPC_VISITOR_90_DAY_LIMIT', releasedAt: now, updatedAt: now,
              }).where(eq(opportunity.id, funded.id));
              outstanding -= funded.reservedNanos;
            }
            continue;
          }
        }
        const releasedExposure = funded?.reservedNanos ?? 0n;
        if (outstanding + totalCarry + BigInt(total) * CENT + serve.billingPriceNanos - releasedExposure > fundedCapacity) continue;
        const carryFilter = and(eq(s.adsSettlementCarries.escrowId, escrow.id), eq(s.adsSettlementCarries.allocatedUsdCents, escrow.allocatedUsdCents), eq(s.adsSettlementCarries.promoterId, promoter.id));
        await tx.insert(s.adsSettlementCarries).values({ escrowId: escrow.id, allocatedUsdCents: escrow.allocatedUsdCents, promoterId: promoter.id }).onConflictDoNothing();
        const [carry] = await tx.select().from(s.adsSettlementCarries).where(carryFilter).for('update');
        if (carry.carryNanos < 0n || carry.carryNanos >= CENT) throw new ConflictException('Settlement carry requires reconciliation');
        const nanos = carry.carryNanos + serve.billingPriceNanos, cents = Number(nanos / CENT);
        if (!Number.isSafeInteger(cents) || cents > MAX || total + cents > escrow.allocatedUsdCents - escrow.consumedUsdCents - escrow.refundedUsdCents ||
          total + cents > wallet.lockedUsdCents || total + cents > campaign.remainingBudgetUsdCents) continue;
        const billed = carry.billedUsdCents + cents;
        if (!Number.isSafeInteger(billed) || billed > MAX) throw new ConflictException('Settlement exceeds its generation limit');
        const publisher = Number(BigInt(billed) * 55n / 100n), commission = Number(BigInt(billed) * 15n / 100n);
        const earned = publisher - carry.publisherUsdCents, pool = commission - carry.commissionPoolUsdCents;
        // Cumulative floor shares preserve the policy across tiny batches. A -1 base delta can
        // reclassify a prior rounding cent into the commission pool; it never credits a wallet.
        if (earned < 0 || pool < 0 || earned > cents || pool > cents) throw new ConflictException('Settlement distribution requires reconciliation');
        await tx.insert(s.adsSettlementClaims).values({ interactionId: event.id, serveId: serve.id, escrowId: escrow.id,
          allocatedUsdCents: escrow.allocatedUsdCents, promoterId: promoter.id, batchId, priceNanos: serve.billingPriceNanos });
        if (funded) {
          await tx.update(opportunity).set({ settledAt: now, updatedAt: now }).where(eq(opportunity.id, funded.id));
          outstanding -= releasedExposure;
        }
        totalCarry += nanos % CENT - carry.carryNanos;
        seen.add(serve.id);
        await tx.update(s.adsSettlementCarries).set({ carryNanos: nanos % CENT, billedUsdCents: billed,
          publisherUsdCents: publisher, commissionPoolUsdCents: commission, updatedAt: now }).where(eq(s.adsSettlementCarries.id, carry.id));
        if (event.type === 'click') clicks++; else impressions++;
        if (cents > 0) {
          const itemId = randomUUID(), receiptId = randomUUID();
          await tx.insert(s.billingTransactions).values({ id: receiptId, userId: promoter.userId, type: 'ads_earning', status: 'pending', provider: 'internal',
            amountUsdCents: earned, grossAmountUsdCents: cents, netAmountUsdCents: earned, feeAmountUsdCents: cents - earned,
            idempotencyKey: `ads-earning:v3:${itemId}`, reference: `ads-earning-v3-${itemId}`,
            metadata: JSON.stringify({ version: 3, kind: 'funded_ad_earning', campaignId, escrowId: escrow.id, batchId, itemId,
              promoterId: promoter.id, commissionPoolUsdCents: pool, baseRevenueUsdCents: cents - earned - pool, settlementClaimId: event.id }) });
          await tx.insert(s.adsPromoterSettlementItems).values({ id: itemId, batchId, promoterId: promoter.id, placementId: placement?.id ?? null,
            campaignId, earnedUsdCents: earned, billedUsdCents: cents, billingTransactionId: receiptId, idempotencyKey: `ads-item:v3:${event.id}`,
            impressionsCount: event.type === 'viewable_impression' ? 1 : 0, clicksCount: event.type === 'click' ? 1 : 0,
            status: 'pending', clearanceStatus: 'pending', holdExpiresAt: new Date(now.getTime() + 72 * 3600_000) });
          total += cents; publisherTotal += earned;
        }
      }
      if (eventId && !seen.size && !frequencyExcluded) throw new ConflictException('The requested event is not ready to settle');
      if (total > 0) {
        await tx.update(s.billingWallets).set({ lockedUsdCents: wallet.lockedUsdCents - total, version: sql`${s.billingWallets.version} + 1`, updatedAt: now }).where(eq(s.billingWallets.id, wallet.id));
        await tx.update(s.adsCampaignEscrows).set({ consumedUsdCents: escrow.consumedUsdCents + total, lastSettledAt: now, updatedAt: now,
          status: escrow.consumedUsdCents + escrow.refundedUsdCents + total === escrow.allocatedUsdCents ? 'exhausted' : 'active' }).where(eq(s.adsCampaignEscrows.id, escrow.id));
        await tx.update(s.adsCampaigns).set({ remainingBudgetUsdCents: campaign.remainingBudgetUsdCents - total, updatedAt: now }).where(eq(s.adsCampaigns.id, campaignId));
        await tx.insert(s.billingTransactions).values({ userId: campaign.advertiserId, type: 'ads_spend', status: 'completed', provider: 'internal', amountUsdCents: total,
          idempotencyKey: key, reference: `ads-spend-v3-${batchId}`, metadata: JSON.stringify({ version: 3, kind: 'funded_ad_spend', campaignId, escrowId: escrow.id, batchId,
            allocatedUsdCents: escrow.allocatedUsdCents, publisherPendingUsdCents: publisherTotal, platformRetainedUsdCents: total - publisherTotal }) });
      }
      await tx.update(s.adsSettlementBatches).set({ status: 'completed', totalDebitedUsdCents: total, totalCreditedUsdCents: 0,
        totalImpressions: impressions, totalClicks: clicks, completedAt: now }).where(eq(s.adsSettlementBatches.id, batchId));
      return { batchId, status: 'completed', billedUsdCents: total, publisherPendingUsdCents: publisherTotal, replayed: false };
    });
  }
}
