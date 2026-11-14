import { randomUUID } from 'crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@crimfig/database/schema';
import { NANO_CENT, validEvidenceSignature } from '@crimfig/shared';

export interface ClickReconciliationWindow {
  lower: string | Date;
  upper: string | Date;
}

export interface CarryRebateAdjustment {
  rebateCents: number;
  publisherReversalCents: number;
  commissionReversalCents: number;
  baseReversalCents: number;
  nextBilled: number;
  nextCarryNanos: bigint;
  nextPublisher: number;
  nextCommission: number;
}

export interface CarryRestoreAdjustment {
  debitCents: number;
  publisherRestoreCents: number;
  commissionRestoreCents: number;
  baseRestoreCents: number;
  nextBilled: number;
  nextCarryNanos: bigint;
  nextPublisher: number;
  nextCommission: number;
}

export interface EventCashRebateSummary {
  candidates: number;
  rebatesApplied: number;
  rebateUsdCents: number;
  penaltiesCreatedUsdCents: number;
  skippedAlreadyProcessed: number;
  skippedNoLongerInvalid: number;
  skippedFullChainRejected: number;
}

export interface EventCashRestoreSummary {
  candidates: number;
  restoredCount: number;
  restoredDebitUsdCents: number;
  promoterCreditedUsdCents: number;
  deferredInsufficientBalance: number;
  skippedNotRejectedOrAlreadyRestored: number;
}

const MAX_PG_INT = 2147483647;

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid reconciliation window boundary');
  return date.toISOString();
}

export function verifyAssessmentRecord(
  assessment: {
    id: string;
    eventId: string;
    campaignId: string | null;
    requestId: string;
    actorId: string;
    policyVersion: string;
    outcome: string;
    reasonCodes: unknown;
    features: unknown;
    supersedesId: string | null;
    keyId: string;
    recordHash: string;
  },
  env = process.env,
): boolean {
  return validEvidenceSignature(
    {
      id: assessment.id,
      eventId: assessment.eventId,
      campaignId: assessment.campaignId,
      requestId: assessment.requestId,
      actorId: assessment.actorId,
      policyVersion: assessment.policyVersion,
      outcome: assessment.outcome,
      reasonCodes: assessment.reasonCodes,
      features: assessment.features,
      supersedesId: assessment.supersedesId,
      keyId: assessment.keyId,
    },
    assessment.recordHash,
    env,
  );
}

/**
 * Removes an invalidated claim's exact nano-cent price from the cumulative
 * (escrowId, allocatedUsdCents, promoterId) 55/30/15 settlement carry accumulator.
 */
export function computeCarryRebateAdjustments(
  carry: {
    carryNanos: bigint;
    billedUsdCents: number;
    publisherUsdCents: number;
    commissionPoolUsdCents: number;
  },
  claimPriceNanos: bigint,
): CarryRebateAdjustment {
  if (claimPriceNanos < 0n || carry.carryNanos < 0n || carry.carryNanos >= NANO_CENT || carry.billedUsdCents < 0) {
    throw new Error('Settlement carry invariant violated before event rebate');
  }
  const totalNanos = BigInt(carry.billedUsdCents) * NANO_CENT + carry.carryNanos;
  if (totalNanos < claimPriceNanos) {
    throw new Error('Claimed settlement nanos exceed remaining carry balance');
  }
  const remainingNanos = totalNanos - claimPriceNanos;
  const nextBilled = Number(remainingNanos / NANO_CENT);
  const nextCarryNanos = remainingNanos % NANO_CENT;
  if (!Number.isSafeInteger(nextBilled) || nextBilled > MAX_PG_INT) {
    throw new Error('Reconciled billed cents overflow safe integer bounds');
  }
  const nextPublisher = Number((BigInt(nextBilled) * 55n) / 100n);
  const nextCommission = Number((BigInt(nextBilled) * 15n) / 100n);
  const rebateCents = carry.billedUsdCents - nextBilled;
  const publisherReversalCents = carry.publisherUsdCents - nextPublisher;
  const commissionReversalCents = carry.commissionPoolUsdCents - nextCommission;
  const baseReversalCents = rebateCents - publisherReversalCents - commissionReversalCents;
  if (
    rebateCents < 0 ||
    publisherReversalCents < 0 ||
    commissionReversalCents < 0 ||
    baseReversalCents < 0
  ) {
    throw new Error('Computed carry rebate components violate non-negativity invariant');
  }
  return {
    rebateCents,
    publisherReversalCents,
    commissionReversalCents,
    baseReversalCents,
    nextBilled,
    nextCarryNanos,
    nextPublisher,
    nextCommission,
  };
}

/**
 * Re-applies an overturned claim's exact nano-cent price onto the cumulative
 * 55/30/15 settlement carry accumulator.
 */
export function computeCarryRestoreAdjustments(
  carry: {
    carryNanos: bigint;
    billedUsdCents: number;
    publisherUsdCents: number;
    commissionPoolUsdCents: number;
  },
  claimPriceNanos: bigint,
): CarryRestoreAdjustment {
  if (claimPriceNanos < 0n || carry.carryNanos < 0n || carry.carryNanos >= NANO_CENT || carry.billedUsdCents < 0) {
    throw new Error('Settlement carry invariant violated before event restore');
  }
  const totalNanos = BigInt(carry.billedUsdCents) * NANO_CENT + carry.carryNanos + claimPriceNanos;
  const nextBilled = Number(totalNanos / NANO_CENT);
  const nextCarryNanos = totalNanos % NANO_CENT;
  if (!Number.isSafeInteger(nextBilled) || nextBilled > MAX_PG_INT) {
    throw new Error('Restored billed cents overflow safe integer bounds');
  }
  const nextPublisher = Number((BigInt(nextBilled) * 55n) / 100n);
  const nextCommission = Number((BigInt(nextBilled) * 15n) / 100n);
  const debitCents = nextBilled - carry.billedUsdCents;
  const publisherRestoreCents = nextPublisher - carry.publisherUsdCents;
  const commissionRestoreCents = nextCommission - carry.commissionPoolUsdCents;
  const baseRestoreCents = debitCents - publisherRestoreCents - commissionRestoreCents;
  if (
    debitCents < 0 ||
    publisherRestoreCents < 0 ||
    commissionRestoreCents < 0 ||
    baseRestoreCents < 0
  ) {
    throw new Error('Computed carry restore components violate non-negativity invariant');
  }
  return {
    debitCents,
    publisherRestoreCents,
    commissionRestoreCents,
    baseRestoreCents,
    nextBilled,
    nextCarryNanos,
    nextPublisher,
    nextCommission,
  };
}

async function lockTransactionTimeouts(tx: any) {
  await tx.execute(sql`set local lock_timeout = '5s'`);
  await tx.execute(sql`set local statement_timeout = '8s'`);
}

async function findEventSettlementItem(tx: any, campaignId: string, promoterId: string, eventId: string) {
  const rows = await tx
    .select({
      item: s.adsPromoterSettlementItems,
      receipt: s.billingTransactions,
    })
    .from(s.adsPromoterSettlementItems)
    .leftJoin(s.billingTransactions, eq(s.billingTransactions.id, s.adsPromoterSettlementItems.billingTransactionId))
    .where(
      and(
        eq(s.adsPromoterSettlementItems.campaignId, campaignId),
        eq(s.adsPromoterSettlementItems.promoterId, promoterId),
        sql`(
          ${s.adsPromoterSettlementItems.idempotencyKey} = ${`ads-item:v3:${eventId}`}
          OR (${s.billingTransactions.metadata}::jsonb)->>'settlementClaimId' = ${eventId}
        )`,
      ),
    )
    .orderBy(asc(s.adsPromoterSettlementItems.id))
    .for('update', { of: s.adsPromoterSettlementItems });
  return rows[0] ?? null;
}

/**
 * Applies event-specific cash rebates and publisher hold/penalty reversals
 * for paid settled clicks whose latest signed post-click assessment is 'invalid'.
 * Preserves immutable ads_spend / escrow.consumed_usd_cents invariants by using
 * internal_credit rebates + ads_settlement_rebates + ads_promoter_penalties.
 */
export async function applyEventCashRebates(
  db: NodePgDatabase<typeof s>,
  window: ClickReconciliationWindow,
  env = process.env,
): Promise<EventCashRebateSummary> {
  const lowerIso = toIso(window.lower);
  const upperIso = toIso(window.upper);

  return db.transaction(async (tx) => {
    await lockTransactionTimeouts(tx);

    const candidateResult = await tx.execute(sql`
      SELECT DISTINCT c.interaction_id AS event_id, e.campaign_id
      FROM ads_settlement_claims c
      JOIN ads_campaign_escrows e ON e.id = c.escrow_id
      JOIN ads_event_assessments a ON a.event_id = c.interaction_id
      WHERE a.created_at >= ${lowerIso}::timestamptz
        AND a.created_at <= ${upperIso}::timestamptz
        AND a.outcome = 'invalid'
      ORDER BY e.campaign_id ASC, c.interaction_id ASC
    `);

    const rows = ((candidateResult as any).rows ?? candidateResult) as Array<{
      event_id: string;
      campaign_id: string;
    }>;

    const summary: EventCashRebateSummary = {
      candidates: rows.length,
      rebatesApplied: 0,
      rebateUsdCents: 0,
      penaltiesCreatedUsdCents: 0,
      skippedAlreadyProcessed: 0,
      skippedNoLongerInvalid: 0,
      skippedFullChainRejected: 0,
    };

    const byCampaign = new Map<string, string[]>();
    for (const row of rows) {
      const list = byCampaign.get(row.campaign_id) ?? [];
      list.push(row.event_id);
      byCampaign.set(row.campaign_id, list);
    }

    for (const [campaignId, eventIds] of byCampaign.entries()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${campaignId}`}, 0))`);
      const [campaign] = await tx
        .select()
        .from(s.adsCampaigns)
        .where(eq(s.adsCampaigns.id, campaignId))
        .for('share');
      if (!campaign) continue;

      for (const eventId of eventIds) {
        const [latest] = await tx
          .select()
          .from(s.adsEventAssessments)
          .where(eq(s.adsEventAssessments.eventId, eventId))
          .orderBy(desc(s.adsEventAssessments.createdAt), desc(s.adsEventAssessments.id))
          .limit(1);

        if (!latest) continue;
        if (!verifyAssessmentRecord(latest, env)) {
          throw new Error(`Invalid assessment evidence signature for event ${eventId} (${latest.id})`);
        }
        if (latest.outcome !== 'invalid') {
          summary.skippedNoLongerInvalid += 1;
          continue;
        }

        const [claim] = await tx
          .select()
          .from(s.adsSettlementClaims)
          .where(eq(s.adsSettlementClaims.interactionId, eventId))
          .for('update');
        if (!claim) continue;

        const [escrow] = await tx
          .select()
          .from(s.adsCampaignEscrows)
          .where(eq(s.adsCampaignEscrows.id, claim.escrowId))
          .for('update');
        if (!escrow || escrow.campaignId !== campaignId) {
          throw new Error(`Settlement escrow ownership mismatch for event ${eventId}`);
        }

        // Do not double-rebate if the entire (escrowId, promoterId) chain was already rejected.
        const [fullChainRejected] = await tx
          .select({ id: s.billingProviderEvents.id })
          .from(s.billingProviderEvents)
          .where(
            and(
              eq(s.billingProviderEvents.provider, 'paystack'),
              eq(s.billingProviderEvents.eventType, 'internal.ad.rejection'),
              eq(s.billingProviderEvents.processed, true),
              sql`${s.billingProviderEvents.errorMessage} IS DISTINCT FROM 'review_dismissed'`,
              sql`${s.billingProviderEvents.reference} LIKE ${`internal.ad.rejection:${claim.escrowId}:${claim.promoterId}:%`}`,
            ),
          )
          .limit(1);
        if (fullChainRejected) {
          summary.skippedFullChainRejected += 1;
          continue;
        }

        const rejectionRef = `internal.ad.event_rejection:${claim.escrowId}:${claim.promoterId}:${eventId}:${latest.id}`;
        const [alreadySameAssessment] = await tx
          .select({ id: s.billingProviderEvents.id })
          .from(s.billingProviderEvents)
          .where(
            and(
              eq(s.billingProviderEvents.provider, 'paystack'),
              eq(s.billingProviderEvents.reference, rejectionRef),
            ),
          )
          .limit(1);
        if (alreadySameAssessment) {
          summary.skippedAlreadyProcessed += 1;
          continue;
        }

        // Also ensure we don't double-rebate when multiple 'invalid' assessments arrive without an intervening restore.
        const lastStateResult = await tx.execute(sql`
          SELECT reference
          FROM billing_provider_events
          WHERE provider = 'paystack'
            AND processed = true
            AND (
              reference LIKE ${`internal.ad.event_rejection:${claim.escrowId}:${claim.promoterId}:${eventId}:%`}
              OR reference LIKE ${`internal.ad.event_restore:${claim.escrowId}:${claim.promoterId}:${eventId}:%`}
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `);
        const lastStateRows = ((lastStateResult as any).rows ?? lastStateResult) as Array<{ reference: string }>;
        if (lastStateRows[0]?.reference.startsWith('internal.ad.event_rejection:')) {
          summary.skippedAlreadyProcessed += 1;
          continue;
        }

        const [carry] = await tx
          .select()
          .from(s.adsSettlementCarries)
          .where(
            and(
              eq(s.adsSettlementCarries.escrowId, claim.escrowId),
              eq(s.adsSettlementCarries.allocatedUsdCents, claim.allocatedUsdCents),
              eq(s.adsSettlementCarries.promoterId, claim.promoterId),
            ),
          )
          .for('update');
        if (!carry) {
          throw new Error(`Missing settlement carry for claim ${claim.id}`);
        }

        const adj = computeCarryRebateAdjustments(carry, claim.priceNanos);
        const itemRow = await findEventSettlementItem(tx, campaignId, claim.promoterId, eventId);
        const item = itemRow?.item ?? null;
        const receipt = itemRow?.receipt ?? null;

        if (item && ['penalized', 'recovery_pending', 'clawed_back'].includes(item.clearanceStatus)) {
          summary.skippedFullChainRejected += 1;
          continue;
        }

        const now = new Date();
        let penaltyAmount = 0;

        if (item && receipt) {
          const isHeld = item.clearanceStatus === 'pending' && item.status === 'pending' && receipt.status === 'pending';
          const isCleared = item.clearanceStatus === 'cleared' && item.status === 'credited' && receipt.status === 'completed';
          if (!isHeld && !isCleared) {
            throw new Error(`Settlement item ${item.id} state (${item.clearanceStatus}/${receipt.status}) cannot be reconciled automatically`);
          }
          if (isHeld) {
            await tx
              .update(s.billingTransactions)
              .set({ status: 'failed', updatedAt: now })
              .where(eq(s.billingTransactions.id, receipt.id));
            await tx
              .update(s.adsPromoterSettlementItems)
              .set({ status: 'failed', clearanceStatus: 'penalized' })
              .where(eq(s.adsPromoterSettlementItems.id, item.id));
            penaltyAmount = Math.max(0, adj.publisherReversalCents - item.earnedUsdCents);
          } else {
            penaltyAmount = Math.max(adj.publisherReversalCents, item.earnedUsdCents);
            await tx
              .update(s.adsPromoterSettlementItems)
              .set({ clearanceStatus: penaltyAmount > 0 ? 'recovery_pending' : 'clawed_back' })
              .where(eq(s.adsPromoterSettlementItems.id, item.id));
          }
        } else {
          penaltyAmount = adj.publisherReversalCents;
        }

        if (adj.rebateCents > 0) {
          await tx
            .insert(s.billingWallets)
            .values({ userId: campaign.advertiserId })
            .onConflictDoNothing({ target: s.billingWallets.userId });
          const [advWallet] = await tx
            .select()
            .from(s.billingWallets)
            .where(eq(s.billingWallets.userId, campaign.advertiserId))
            .for('update');
          const nextBalance = advWallet.balanceUsdCents + adj.rebateCents;
          if (!Number.isSafeInteger(nextBalance) || advWallet.balanceUsdCents < 0 || nextBalance > MAX_PG_INT) {
            throw new Error(`Advertiser wallet overflow during event rebate for campaign ${campaign.id}`);
          }
          await tx
            .update(s.billingWallets)
            .set({
              balanceUsdCents: nextBalance,
              version: sql`${s.billingWallets.version} + 1`,
              updatedAt: now,
            })
            .where(eq(s.billingWallets.id, advWallet.id));

          const [rebateTx] = await tx
            .insert(s.billingTransactions)
            .values({
              userId: campaign.advertiserId,
              type: 'internal_credit',
              status: 'completed',
              provider: 'internal',
              amountUsdCents: adj.rebateCents,
              idempotencyKey: `ads-rejection:v1:event:${eventId}:${latest.id}`,
              reference: `ads-rejection-v1-event-${eventId}-${latest.id}`,
              balanceBeforeUsdCents: advWallet.balanceUsdCents,
              balanceAfterUsdCents: nextBalance,
              metadata: JSON.stringify({
                version: 1,
                kind: 'funded_ad_event_rebate',
                eventId,
                assessmentId: latest.id,
                escrowId: claim.escrowId,
                promoterId: claim.promoterId,
                campaignId: campaign.id,
                publisherReversalUsdCents: adj.publisherReversalCents,
                commissionReversalUsdCents: adj.commissionReversalCents,
                baseRevenueReversalUsdCents: adj.baseReversalCents,
              }),
            })
            .returning();

          await tx.insert(s.adsSettlementRebates).values({
            campaignId: campaign.id,
            advertiserId: campaign.advertiserId,
            promoterId: claim.promoterId,
            sourceProcessType: 'scheduled_click_audit',
            rebateReasonCode: 'invalidated_click_event',
            rebateAmountUsdCents: adj.rebateCents,
            billingTransactionId: rebateTx.id,
            status: 'completed',
          });
        }

        const eventRejectionId = randomUUID();
        await tx.insert(s.billingProviderEvents).values({
          id: eventRejectionId,
          provider: 'paystack',
          reference: rejectionRef,
          eventType: 'internal.ad.rejection',
          processed: true,
          processedAt: now,
          rawPayload: {
            version: 1,
            kind: 'event_specific_rejection',
            eventId,
            assessmentId: latest.id,
            escrowId: claim.escrowId,
            promoterId: claim.promoterId,
            campaignId: campaign.id,
            evidenceId: latest.id,
            priceNanos: String(claim.priceNanos),
            rebateUsdCents: adj.rebateCents,
            publisherReversalUsdCents: adj.publisherReversalCents,
            commissionReversalUsdCents: adj.commissionReversalCents,
            baseRevenueReversalUsdCents: adj.baseReversalCents,
            snapshot: {
              items: [
                {
                  id: item?.id ?? null,
                  released: penaltyAmount > 0,
                  earned: penaltyAmount,
                },
              ],
            },
          },
        });

        if (penaltyAmount > 0) {
          await tx.insert(s.adsPromoterPenalties).values({
            id: eventRejectionId,
            promoterId: claim.promoterId,
            auditLevel: 'scheduled',
            penaltyAmountUsdCents: penaltyAmount,
            recoveredAmountUsdCents: 0,
            status: 'outstanding',
            reasonCode: 'invalidated_click_event',
          });
        }

        await tx
          .update(s.adsSettlementCarries)
          .set({
            carryNanos: adj.nextCarryNanos,
            billedUsdCents: adj.nextBilled,
            publisherUsdCents: adj.nextPublisher,
            commissionPoolUsdCents: adj.nextCommission,
            updatedAt: now,
          })
          .where(eq(s.adsSettlementCarries.id, carry.id));

        await tx
          .update(s.adsInteractions)
          .set({
            isValid: false,
            invalidReason: 'post_click_invalidated',
            assessmentStatus: 'invalidated',
            financialEligibility: 'invalid',
          })
          .where(eq(s.adsInteractions.id, eventId));

        summary.rebatesApplied += 1;
        summary.rebateUsdCents += adj.rebateCents;
        summary.penaltiesCreatedUsdCents += penaltyAmount;
      }
    }

    return summary;
  });
}

/**
 * Reverses an event-specific cash rebate when a newer signed assessment overturns
 * an earlier invalidation back to 'eligible'. Fails closed (zero negative wallet) if
 * the advertiser lacks sufficient available wallet funds to cover the restore debit.
 */
export async function restoreOverturnedEventCash(
  db: NodePgDatabase<typeof s>,
  window: ClickReconciliationWindow,
  env = process.env,
): Promise<EventCashRestoreSummary> {
  const lowerIso = toIso(window.lower);
  const upperIso = toIso(window.upper);

  return db.transaction(async (tx) => {
    await lockTransactionTimeouts(tx);

    const candidateResult = await tx.execute(sql`
      SELECT DISTINCT c.interaction_id AS event_id, e.campaign_id
      FROM ads_settlement_claims c
      JOIN ads_campaign_escrows e ON e.id = c.escrow_id
      JOIN ads_event_assessments a ON a.event_id = c.interaction_id
      WHERE a.created_at >= ${lowerIso}::timestamptz
        AND a.created_at <= ${upperIso}::timestamptz
        AND a.outcome = 'eligible'
      ORDER BY e.campaign_id ASC, c.interaction_id ASC
    `);

    const rows = ((candidateResult as any).rows ?? candidateResult) as Array<{
      event_id: string;
      campaign_id: string;
    }>;

    const summary: EventCashRestoreSummary = {
      candidates: rows.length,
      restoredCount: 0,
      restoredDebitUsdCents: 0,
      promoterCreditedUsdCents: 0,
      deferredInsufficientBalance: 0,
      skippedNotRejectedOrAlreadyRestored: 0,
    };

    const byCampaign = new Map<string, string[]>();
    for (const row of rows) {
      const list = byCampaign.get(row.campaign_id) ?? [];
      list.push(row.event_id);
      byCampaign.set(row.campaign_id, list);
    }

    for (const [campaignId, eventIds] of byCampaign.entries()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${campaignId}`}, 0))`);
      const [campaign] = await tx
        .select()
        .from(s.adsCampaigns)
        .where(eq(s.adsCampaigns.id, campaignId))
        .for('share');
      if (!campaign) continue;

      for (const eventId of eventIds) {
        const [latest] = await tx
          .select()
          .from(s.adsEventAssessments)
          .where(eq(s.adsEventAssessments.eventId, eventId))
          .orderBy(desc(s.adsEventAssessments.createdAt), desc(s.adsEventAssessments.id))
          .limit(1);

        if (!latest) continue;
        if (!verifyAssessmentRecord(latest, env)) {
          throw new Error(`Invalid assessment evidence signature for event ${eventId} (${latest.id})`);
        }
        if (latest.outcome !== 'eligible') {
          summary.skippedNotRejectedOrAlreadyRestored += 1;
          continue;
        }

        const [claim] = await tx
          .select()
          .from(s.adsSettlementClaims)
          .where(eq(s.adsSettlementClaims.interactionId, eventId))
          .for('update');
        if (!claim) continue;

        const [promoter] = await tx
          .select()
          .from(s.adsPromoters)
          .where(eq(s.adsPromoters.id, claim.promoterId))
          .for('share');
        if (!promoter) continue;

        const lastStateResult = await tx.execute(sql`
          SELECT id, reference, raw_payload
          FROM billing_provider_events
          WHERE provider = 'paystack'
            AND processed = true
            AND (
              reference LIKE ${`internal.ad.event_rejection:${claim.escrowId}:${claim.promoterId}:${eventId}:%`}
              OR reference LIKE ${`internal.ad.event_restore:${claim.escrowId}:${claim.promoterId}:${eventId}:%`}
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `);
        const lastStateRows = ((lastStateResult as any).rows ?? lastStateResult) as Array<{
          id: string;
          reference: string;
          raw_payload: any;
        }>;
        const priorRejection = lastStateRows[0];
        if (!priorRejection || !priorRejection.reference.startsWith('internal.ad.event_rejection:')) {
          summary.skippedNotRejectedOrAlreadyRestored += 1;
          continue;
        }

        const restoreRef = `internal.ad.event_restore:${claim.escrowId}:${claim.promoterId}:${eventId}:${latest.id}`;
        const [alreadyRestoredSame] = await tx
          .select({ id: s.billingProviderEvents.id })
          .from(s.billingProviderEvents)
          .where(
            and(
              eq(s.billingProviderEvents.provider, 'paystack'),
              eq(s.billingProviderEvents.reference, restoreRef),
            ),
          )
          .limit(1);
        if (alreadyRestoredSame) {
          summary.skippedNotRejectedOrAlreadyRestored += 1;
          continue;
        }

        const [carry] = await tx
          .select()
          .from(s.adsSettlementCarries)
          .where(
            and(
              eq(s.adsSettlementCarries.escrowId, claim.escrowId),
              eq(s.adsSettlementCarries.allocatedUsdCents, claim.allocatedUsdCents),
              eq(s.adsSettlementCarries.promoterId, claim.promoterId),
            ),
          )
          .for('update');
        if (!carry) {
          throw new Error(`Missing settlement carry for claim ${claim.id}`);
        }

        const adj = computeCarryRestoreAdjustments(carry, claim.priceNanos);

        let advWallet: typeof s.billingWallets.$inferSelect | undefined;
        if (adj.debitCents > 0) {
          await tx
            .insert(s.billingWallets)
            .values({ userId: campaign.advertiserId })
            .onConflictDoNothing({ target: s.billingWallets.userId });
          [advWallet] = await tx
            .select()
            .from(s.billingWallets)
            .where(eq(s.billingWallets.userId, campaign.advertiserId))
            .for('update');
          if (!advWallet || advWallet.balanceUsdCents < adj.debitCents) {
            summary.deferredInsufficientBalance += 1;
            continue;
          }
        }

        const now = new Date();

        if (adj.debitCents > 0 && advWallet) {
          const nextBalance = advWallet.balanceUsdCents - adj.debitCents;
          await tx
            .update(s.billingWallets)
            .set({
              balanceUsdCents: nextBalance,
              version: sql`${s.billingWallets.version} + 1`,
              updatedAt: now,
            })
            .where(eq(s.billingWallets.id, advWallet.id));

          await tx.insert(s.billingTransactions).values({
            userId: campaign.advertiserId,
            type: 'internal_debit',
            status: 'completed',
            provider: 'internal',
            amountUsdCents: adj.debitCents,
            idempotencyKey: `ads-restore:v1:event:${eventId}:${latest.id}`,
            reference: `ads-restore-v1-event-${eventId}-${latest.id}`,
            balanceBeforeUsdCents: advWallet.balanceUsdCents,
            balanceAfterUsdCents: nextBalance,
            metadata: JSON.stringify({
              version: 1,
              kind: 'funded_ad_event_restore',
              eventId,
              assessmentId: latest.id,
              priorRejectionEventId: priorRejection.id,
              escrowId: claim.escrowId,
              promoterId: claim.promoterId,
              campaignId: campaign.id,
            }),
          });
        }

        const [penalty] = await tx
          .select()
          .from(s.adsPromoterPenalties)
          .where(eq(s.adsPromoterPenalties.id, priorRejection.id))
          .for('update');
        if (penalty) {
          if (penalty.recoveredAmountUsdCents > 0) {
            await tx
              .insert(s.billingWallets)
              .values({ userId: promoter.userId })
              .onConflictDoNothing({ target: s.billingWallets.userId });
            const [promWallet] = await tx
              .select()
              .from(s.billingWallets)
              .where(eq(s.billingWallets.userId, promoter.userId))
              .for('update');
            const promNextBalance = promWallet.balanceUsdCents + penalty.recoveredAmountUsdCents;
            if (!Number.isSafeInteger(promNextBalance) || promNextBalance > MAX_PG_INT) {
              throw new Error(`Promoter wallet overflow restoring recovered penalty ${penalty.id}`);
            }
            await tx
              .update(s.billingWallets)
              .set({
                balanceUsdCents: promNextBalance,
                version: sql`${s.billingWallets.version} + 1`,
                updatedAt: now,
              })
              .where(eq(s.billingWallets.id, promWallet.id));

            await tx.insert(s.billingTransactions).values({
              userId: promoter.userId,
              type: 'internal_credit',
              status: 'completed',
              provider: 'internal',
              amountUsdCents: penalty.recoveredAmountUsdCents,
              idempotencyKey: `ads-restore-promoter:v1:event:${eventId}:${latest.id}`,
              reference: `ads-restore-promoter-v1-event-${eventId}-${latest.id}`,
              balanceBeforeUsdCents: promWallet.balanceUsdCents,
              balanceAfterUsdCents: promNextBalance,
              metadata: JSON.stringify({
                version: 1,
                kind: 'funded_ad_event_penalty_refund',
                eventId,
                assessmentId: latest.id,
                penaltyId: penalty.id,
                escrowId: claim.escrowId,
                promoterId: claim.promoterId,
              }),
            });
            summary.promoterCreditedUsdCents += penalty.recoveredAmountUsdCents;
          }

          await tx
            .update(s.adsPromoterPenalties)
            .set({ status: 'waived', updatedAt: now })
            .where(eq(s.adsPromoterPenalties.id, penalty.id));
        }

        const itemRow = await findEventSettlementItem(tx, campaignId, claim.promoterId, eventId);
        if (itemRow?.item) {
          const { item, receipt } = itemRow;
          if (item.clearanceStatus === 'penalized' && receipt) {
            await tx
              .update(s.billingTransactions)
              .set({ status: 'pending', updatedAt: now })
              .where(eq(s.billingTransactions.id, receipt.id));
            await tx
              .update(s.adsPromoterSettlementItems)
              .set({ status: 'pending', clearanceStatus: 'pending' })
              .where(eq(s.adsPromoterSettlementItems.id, item.id));
          } else if (item.clearanceStatus === 'recovery_pending' || item.clearanceStatus === 'clawed_back') {
            await tx
              .update(s.adsPromoterSettlementItems)
              .set({ clearanceStatus: 'cleared' })
              .where(eq(s.adsPromoterSettlementItems.id, item.id));
          }
        }

        await tx
          .update(s.adsSettlementCarries)
          .set({
            carryNanos: adj.nextCarryNanos,
            billedUsdCents: adj.nextBilled,
            publisherUsdCents: adj.nextPublisher,
            commissionPoolUsdCents: adj.nextCommission,
            updatedAt: now,
          })
          .where(eq(s.adsSettlementCarries.id, carry.id));

        await tx
          .update(s.adsInteractions)
          .set({
            isValid: true,
            invalidReason: null,
            assessmentStatus: 'validated',
            ivtCategory: 'unclassified',
            financialEligibility: 'eligible',
          })
          .where(eq(s.adsInteractions.id, eventId));

        await tx.insert(s.billingProviderEvents).values({
          provider: 'paystack',
          reference: restoreRef,
          eventType: 'internal.ad.event_restore',
          processed: true,
          processedAt: now,
          rawPayload: {
            version: 1,
            kind: 'event_specific_restore',
            eventId,
            assessmentId: latest.id,
            priorRejectionEventId: priorRejection.id,
            escrowId: claim.escrowId,
            promoterId: claim.promoterId,
            campaignId: campaign.id,
            restoreDebitUsdCents: adj.debitCents,
          },
        });

        summary.restoredCount += 1;
        summary.restoredDebitUsdCents += adj.debitCents;
      }
    }

    return summary;
  });
}

