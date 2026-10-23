import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash, randomUUID } from 'crypto';
import * as s from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { AdClearanceService } from './ad-clearance.service';

/** Reject the entire held publisher/escrow claim chain, including fractional carry.
 * Never infer a partial rebate from one click or silently debit a released wallet.
 * Released earnings become a proven receivable, recovered only from future earnings.
 */
@Injectable()
export class AdRejectionService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof s>, private readonly operators: AdClearanceService) {}

  private reference(escrowId: string, promoterId: string) { return `internal.ad.rejection:${escrowId}:${promoterId}`; }
  private reviewFilter(escrowId: string, promoterId: string) {
    return and(eq(s.billingProviderEvents.provider, 'paystack'), eq(s.billingProviderEvents.eventType, 'internal.ad.rejection'),
      sql`${s.billingProviderEvents.reference} like ${this.reference(escrowId, promoterId) + ':%'}`);
  }
  private async context(tx: any, actor: string, escrowId: string, promoterId: string) {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`set local transaction_timeout = '15s'`);
    await this.operators.authorize(actor, tx);
    const [lookup] = await tx.select().from(s.adsCampaignEscrows).where(eq(s.adsCampaignEscrows.id, escrowId));
    if (!lookup) throw new NotFoundException('Escrow not found');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${lookup.campaignId}`},0))`);
    const [escrow] = await tx.select().from(s.adsCampaignEscrows).where(eq(s.adsCampaignEscrows.id, escrowId)).for('update');
    const [campaign] = await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id, escrow.campaignId)).for('share');
    const [promoter] = await tx.select().from(s.adsPromoters).where(eq(s.adsPromoters.id, promoterId)).for('share');
    if (!campaign || !promoter || escrow.userId !== campaign.advertiserId) throw new ConflictException('Settlement ownership requires reconciliation');
    if ([campaign.advertiserId, promoter.userId].includes(actor)) throw new ForbiddenException('Financial beneficiaries cannot review their settlement');
    return { escrow, campaign, promoter };
  }

  private async snapshot(tx: any, escrowId: string, promoterId: string, campaignId: string, publisherId: string) {
    const claims = await tx.select().from(s.adsSettlementClaims).where(and(
      eq(s.adsSettlementClaims.escrowId, escrowId), eq(s.adsSettlementClaims.promoterId, promoterId)))
      .orderBy(asc(s.adsSettlementClaims.id)).for('share');
    if (!claims.length) throw new ConflictException('Review requires funded claims');
    const rows = await tx.select({ item: s.adsPromoterSettlementItems, receipt: s.billingTransactions })
      .from(s.adsPromoterSettlementItems).innerJoin(s.billingTransactions, eq(s.billingTransactions.id, s.adsPromoterSettlementItems.billingTransactionId))
      .where(and(eq(s.adsPromoterSettlementItems.campaignId, campaignId), eq(s.adsPromoterSettlementItems.promoterId, promoterId),
        sql`(${s.billingTransactions.metadata}::jsonb)->>'escrowId' = ${escrowId}`))
      .orderBy(asc(s.adsPromoterSettlementItems.id)).for('update', { of: s.adsPromoterSettlementItems });
    let billed = 0;
    const items = [];
    const references = [...new Set(rows.map((row: any) => `ads-spend-v3-${row.item.batchId}`))] as string[];
    const spends = references.length ? await tx.select().from(s.billingTransactions).where(inArray(s.billingTransactions.reference, references)) : [];
    const spendByReference = new Map<string, any>(spends.map((row: any) => [row.reference, row]));
    for (const { item, receipt } of rows) {
      const meta = JSON.parse(receipt.metadata || '{}');
      const held = item.clearanceStatus === 'pending' && item.status === 'pending' && receipt.status === 'pending';
      const released = item.clearanceStatus === 'cleared' && item.status === 'credited' && receipt.status === 'completed';
      if ((!held && !released) ||
        receipt.userId !== publisherId || receipt.provider !== 'internal' || receipt.type !== 'ads_earning' || meta.version !== 3 || meta.kind !== 'funded_ad_earning' ||
        meta.itemId !== item.id || meta.batchId !== item.batchId || meta.promoterId !== promoterId || meta.campaignId !== campaignId ||
        receipt.idempotencyKey !== `ads-earning:v3:${item.id}` || receipt.amountUsdCents !== item.earnedUsdCents ||
        receipt.grossAmountUsdCents !== item.billedUsdCents || !Number.isSafeInteger(item.billedUsdCents) || item.billedUsdCents < 0 ||
        !Number.isSafeInteger(item.earnedUsdCents) || item.earnedUsdCents < 0 || item.earnedUsdCents > item.billedUsdCents ||
        !claims.some((claim: any) => claim.batchId === item.batchId && claim.interactionId === meta.settlementClaimId)) {
        throw new ConflictException('Only proven funded earnings can be rejected; legacy or inconsistent earnings require reconciliation');
      }
      const spend = spendByReference.get(`ads-spend-v3-${item.batchId}`);
      const spendMeta = JSON.parse(spend?.metadata || '{}');
      if (spend?.status !== 'completed' || spend.type !== 'ads_spend' || spend.provider !== 'internal' ||
        spendMeta.escrowId !== escrowId || spendMeta.batchId !== item.batchId || spend.amountUsdCents < item.billedUsdCents) {
        throw new ConflictException('Funded batch receipt required');
      }
      billed += item.billedUsdCents;
      items.push({ id: item.id, receiptId: receipt.id, billed: item.billedUsdCents, earned: item.earnedUsdCents, released });
    }
    const carries = await tx.select().from(s.adsSettlementCarries).where(and(
      eq(s.adsSettlementCarries.escrowId, escrowId), eq(s.adsSettlementCarries.promoterId, promoterId)))
      .orderBy(asc(s.adsSettlementCarries.id)).for('update');
    if (!Number.isSafeInteger(billed) || billed > 2147483647 || carries.reduce((sum: number, carry: any) => sum + carry.billedUsdCents, 0) !== billed) {
      throw new ConflictException('Fractional settlement history requires reconciliation');
    }
    const state = { items, claims: claims.map((claim: any) => ({ id: claim.id, interactionId: claim.interactionId,
      batchId: claim.batchId, allocated: claim.allocatedUsdCents, price: String(claim.priceNanos) })),
      carries: carries.map((carry: any) => ({ id: carry.id, nanos: String(carry.carryNanos), billed: carry.billedUsdCents })), billed };
    return { ...state, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex') };
  }

  async prepare(actor: string, escrowId: string, promoterId: string, evidenceId: string) {
    actor = actor.toLowerCase(); escrowId = escrowId.toLowerCase(); promoterId = promoterId.toLowerCase();
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 200) throw new BadRequestException('Fraud evidence reference required');
    return this.db.transaction(async tx => {
      const { campaign, promoter } = await this.context(tx, actor, escrowId, promoterId);
      const [existing] = await tx.select().from(s.billingProviderEvents).where(and(this.reviewFilter(escrowId, promoterId),
        sql`${s.billingProviderEvents.errorMessage} is distinct from 'review_dismissed'`));
      if (existing) throw new ConflictException('An immutable rejection review already exists');
      const state = await this.snapshot(tx, escrowId, promoterId, campaign.id, promoter.userId);
      const id = randomUUID();
      const [draft] = await tx.insert(s.billingProviderEvents).values({ provider: 'paystack',
        id, reference: `${this.reference(escrowId, promoterId)}:${id}`, eventType: 'internal.ad.rejection', processed: false,
        rawPayload: { version: 1, escrowId, promoterId, campaignId: campaign.id, preparedBy: actor,
          evidenceId: evidenceId.trim(), snapshot: state, preparedAt: new Date().toISOString() } }).onConflictDoNothing().returning();
      if (!draft) throw new ConflictException('An immutable rejection review already exists');
      return { draftId: draft.id, status: 'pending_review', rebateUsdCents: state.billed, claims: state.claims.length,
        recoverableUsdCents: state.items.filter(item => item.released).reduce((sum, item) => sum + item.earned, 0) };
    });
  }

  async approve(actor: string, escrowId: string, promoterId: string, draftId: string) {
    actor = actor.toLowerCase(); escrowId = escrowId.toLowerCase(); promoterId = promoterId.toLowerCase();
    return this.db.transaction(async tx => {
      const { escrow, campaign, promoter } = await this.context(tx, actor, escrowId, promoterId);
      const [draft] = await tx.select().from(s.billingProviderEvents).where(and(eq(s.billingProviderEvents.id, draftId),
        this.reviewFilter(escrowId, promoterId))).for('update');
      const proof = draft?.rawPayload as any;
      if (!proof || proof.version !== 1 || proof.escrowId !== escrowId || proof.promoterId !== promoterId ||
        proof.campaignId !== campaign.id || !proof.evidenceId || proof.preparedBy === actor) throw new ForbiddenException('Independent matching rejection review required');
      await this.operators.authorize(proof.preparedBy, tx);
      if ([campaign.advertiserId, promoter.userId].includes(proof.preparedBy)) throw new ForbiddenException('Financial beneficiaries cannot review their settlement');
      if (draft.errorMessage === 'review_dismissed') throw new ConflictException('Rejection review was dismissed');
      if (draft.processed) return { status: 'rejected', replayed: true, rebateUsdCents: proof.snapshot.billed };
      const state = await this.snapshot(tx, escrowId, promoterId, campaign.id, promoter.userId);
      if (state.digest !== proof.snapshot?.digest || state.billed > escrow.consumedUsdCents) throw new ConflictException('Review changed or escrow proof inconsistent');
      await tx.insert(s.billingWallets).values({ userId: campaign.advertiserId }).onConflictDoNothing({ target: s.billingWallets.userId });
      const [wallet] = await tx.select().from(s.billingWallets).where(eq(s.billingWallets.userId, campaign.advertiserId)).for('update');
      const balance = wallet.balanceUsdCents + state.billed;
      if (!Number.isSafeInteger(balance) || wallet.balanceUsdCents < 0 || balance > 2147483647) throw new ConflictException('Advertiser wallet limit exceeded');
      const now = new Date();
      if (state.billed > 0) {
        await tx.update(s.billingWallets).set({ balanceUsdCents: balance, version: sql`${s.billingWallets.version} + 1`, updatedAt: now }).where(eq(s.billingWallets.id, wallet.id));
        const [rebate] = await tx.insert(s.billingTransactions).values({ userId: campaign.advertiserId, type: 'internal_credit', status: 'completed', provider: 'internal',
          amountUsdCents: state.billed, idempotencyKey: `ads-rejection:v1:${draft.id}`, reference: `ads-rejection-v1-${draft.id}`,
          balanceBeforeUsdCents: wallet.balanceUsdCents, balanceAfterUsdCents: balance,
          metadata: JSON.stringify({ version: 1, kind: 'funded_ad_rebate', escrowId, promoterId, campaignId: campaign.id,
            draftId, digest: state.digest, preparedBy: proof.preparedBy, reviewedBy: actor, evidenceId: proof.evidenceId }) }).returning();
        await tx.insert(s.adsSettlementRebates).values({ campaignId: campaign.id, advertiserId: campaign.advertiserId, promoterId,
          sourceProcessType: 'manual', rebateReasonCode: 'funded_claim_chain_rejected', rebateAmountUsdCents: state.billed, billingTransactionId: rebate.id });
      }
      const held = state.items.filter(item => !item.released), released = state.items.filter(item => item.released);
      if (held.length) {
        await tx.update(s.billingTransactions).set({ status: 'failed', updatedAt: now }).where(inArray(s.billingTransactions.id, held.map(item => item.receiptId)));
        await tx.update(s.adsPromoterSettlementItems).set({ status: 'failed', clearanceStatus: 'penalized' }).where(inArray(s.adsPromoterSettlementItems.id, held.map(item => item.id)));
      }
      const recoverable = released.reduce((sum, item) => sum + item.earned, 0);
      if (released.length) {
        // Prior payout receipts remain completed: money was actually released.
        // Debt is separate, and never makes an existing wallet negative.
        await tx.update(s.adsPromoterSettlementItems).set({ clearanceStatus: recoverable ? 'recovery_pending' : 'clawed_back' })
          .where(inArray(s.adsPromoterSettlementItems.id, released.map(item => item.id)));
      }
      if (recoverable > 0) {
        await tx.insert(s.adsPromoterPenalties).values({ id: draft.id, promoterId, auditLevel: 'manual',
          penaltyAmountUsdCents: recoverable, recoveredAmountUsdCents: 0, status: 'outstanding', reasonCode: 'funded_claim_chain_rejected' });
      }
      await tx.update(s.adsInteractions).set({ isValid: false }).where(inArray(s.adsInteractions.id, state.claims.map((claim: { interactionId: string }) => claim.interactionId)));
      await tx.update(s.billingProviderEvents).set({ processed: true, processedAt: now }).where(eq(s.billingProviderEvents.id, draft.id));
      // Gross spend/carry history stays immutable. The rebate is a distinct credit;
      // the review marker prevents re-use of rejected carry and further settlement.
      return { status: 'rejected', replayed: false, rebateUsdCents: state.billed };
    });
  }

  async read(actor: string, escrowId: string, promoterId: string) {
    actor = actor.toLowerCase(); escrowId = escrowId.toLowerCase(); promoterId = promoterId.toLowerCase();
    return this.db.transaction(async tx => {
      await this.context(tx, actor, escrowId, promoterId);
      return tx.select({ draftId: s.billingProviderEvents.id, processed: s.billingProviderEvents.processed,
        decision: s.billingProviderEvents.errorMessage, evidence: s.billingProviderEvents.rawPayload })
        .from(s.billingProviderEvents).where(this.reviewFilter(escrowId, promoterId)).orderBy(asc(s.billingProviderEvents.createdAt));
    });
  }

  async dismiss(actor: string, escrowId: string, promoterId: string, draftId: string, evidenceId: string) {
    actor = actor.toLowerCase(); escrowId = escrowId.toLowerCase(); promoterId = promoterId.toLowerCase();
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 200) throw new BadRequestException('Dismissal evidence reference required');
    return this.db.transaction(async tx => {
      const { campaign, promoter } = await this.context(tx, actor, escrowId, promoterId);
      const [draft] = await tx.select().from(s.billingProviderEvents).where(and(eq(s.billingProviderEvents.id, draftId),
        this.reviewFilter(escrowId, promoterId))).for('update');
      const proof = draft?.rawPayload as any;
      if (!proof || proof.preparedBy === actor || proof.escrowId !== escrowId || proof.promoterId !== promoterId) throw new ForbiddenException('Independent rejection review required');
      await this.operators.authorize(proof.preparedBy, tx);
      if ([campaign.advertiserId, promoter.userId].includes(proof.preparedBy)) throw new ForbiddenException('Financial beneficiaries cannot review their settlement');
      if (draft.errorMessage === 'review_dismissed') return { status: 'dismissed', replayed: true };
      if (draft.processed) throw new ConflictException('A completed rebate cannot be dismissed');
      await tx.insert(s.billingProviderEvents).values({ provider: 'paystack', reference: `internal.ad.rejection.dismissal:${draftId}`,
        eventType: 'internal.ad.rejection.dismissal', processed: true, processedAt: new Date(),
        rawPayload: { version: 1, draftId, escrowId, promoterId, reviewedBy: actor, evidenceId: evidenceId.trim() } });
      await tx.update(s.billingProviderEvents).set({ processed: true, processedAt: new Date(), errorMessage: 'review_dismissed' }).where(eq(s.billingProviderEvents.id, draftId));
      return { status: 'dismissed', replayed: false };
    });
  }
}
