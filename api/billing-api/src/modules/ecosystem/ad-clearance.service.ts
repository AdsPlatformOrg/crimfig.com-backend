import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as s from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';

@Injectable()
export class AdClearanceService {
  private readonly operators: Set<string>;
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof s>, config: ConfigService) {
    let ids: unknown;
    try { ids = JSON.parse(config.get<string>('BILLING_SETTLEMENT_OPERATOR_IDS') || '[]'); }
    catch { throw new Error('BILLING_SETTLEMENT_OPERATOR_IDS must be a JSON UUID array'); }
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) throw new Error('Invalid settlement operator configuration');
    this.operators = new Set(ids.map(id => id.toLowerCase()));
  }
  private async authorize(actor: string, tx: any) {
    if (typeof actor !== 'string' || !this.operators.has(actor.toLowerCase())) throw new ForbiddenException('Settlement operator access required');
    const [owner] = await tx.select({ status: s.users.status }).from(s.users).where(eq(s.users.id, actor)).for('share');
    if (owner?.status !== 'ACTIVE') throw new ForbiddenException('Active settlement operator required');
  }
  private async context(tx: any, itemId: string, actor: string) {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await this.authorize(actor, tx);
    const [lookup] = await tx.select().from(s.adsPromoterSettlementItems).where(eq(s.adsPromoterSettlementItems.id, itemId));
    if (!lookup) throw new NotFoundException('Settlement item not found');
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${lookup.campaignId}`},0))`);
    const [item] = await tx.select().from(s.adsPromoterSettlementItems).where(eq(s.adsPromoterSettlementItems.id, itemId)).for('update');
    const [receipt] = await tx.select().from(s.billingTransactions).where(eq(s.billingTransactions.id, item.billingTransactionId!)).for('update');
    let meta: any;
    try { meta = JSON.parse(receipt?.metadata || '{}'); } catch { throw new ConflictException('Settlement receipt invalid'); }
    const [campaign] = await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id, item.campaignId)).for('share');
    const [promoter] = await tx.select().from(s.adsPromoters).where(eq(s.adsPromoters.id, item.promoterId)).for('share');
    if (!receipt || !campaign || !promoter || receipt.provider !== 'internal' || receipt.type !== 'ads_earning' ||
      meta.version !== 3 || meta.kind !== 'funded_ad_earning' || meta.itemId !== item.id || meta.batchId !== item.batchId ||
      meta.campaignId !== item.campaignId || meta.promoterId !== item.promoterId || receipt.userId !== promoter.userId ||
      receipt.amountUsdCents !== item.earnedUsdCents || receipt.grossAmountUsdCents !== item.billedUsdCents ||
      !Number.isSafeInteger(item.earnedUsdCents) || item.earnedUsdCents < 0 || item.earnedUsdCents > 2147483647 ||
      receipt.idempotencyKey !== `ads-earning:v3:${item.id}`) throw new ConflictException('Settlement proof requires reconciliation');
    if ([promoter.userId, campaign.advertiserId].includes(actor)) throw new ForbiddenException('Financial beneficiaries cannot review their settlement');
    if (!item.holdExpiresAt || item.holdExpiresAt > new Date()) throw new ConflictException('The 72-hour clearance hold has not expired');
    return { item, receipt, meta, promoter, campaign };
  }

  async prepare(actor: string, itemId: string, evidenceId: string) {
    actor = typeof actor === 'string' ? actor.toLowerCase() : '';
    itemId = itemId.toLowerCase();
    if (typeof evidenceId !== 'string' || !evidenceId.trim() || evidenceId.length > 200) throw new BadRequestException('A fraud-review evidence reference is required');
    return this.db.transaction(async tx => {
      const { item, receipt } = await this.context(tx, itemId, actor);
      if (item.clearanceStatus !== 'pending' || receipt.status !== 'pending') throw new ConflictException('Settlement is not awaiting clearance');
      const [draft] = await tx.insert(s.billingProviderEvents).values({ provider: 'paystack', reference: `internal.ad.clearance:${itemId}`,
        eventType: 'internal.ad.clearance', rawPayload: { version: 3, itemId, evidenceId: evidenceId.trim(), preparedBy: actor,
          preparedAt: new Date().toISOString(), amountUsdCents: item.earnedUsdCents, billedUsdCents: item.billedUsdCents }, processed: false }).onConflictDoNothing().returning();
      if (!draft) throw new ConflictException('An immutable clearance review already exists');
      return { draftId: draft.id, itemId, status: 'pending_review' };
    });
  }

  async read(actor: string, itemId: string) {
    actor = typeof actor === 'string' ? actor.toLowerCase() : '';
    itemId = itemId.toLowerCase();
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await this.authorize(actor, tx);
      const [item] = await tx.select().from(s.adsPromoterSettlementItems).where(eq(s.adsPromoterSettlementItems.id, itemId));
      if (!item) throw new NotFoundException('Settlement item not found');
      const [draft] = await tx.select().from(s.billingProviderEvents).where(and(
        eq(s.billingProviderEvents.provider, 'paystack'), eq(s.billingProviderEvents.reference, `internal.ad.clearance:${itemId}`)));
      return { itemId, batchId: item.batchId, earnedUsdCents: item.earnedUsdCents, billedUsdCents: item.billedUsdCents,
        clearanceStatus: item.clearanceStatus, holdExpiresAt: item.holdExpiresAt,
        review: draft ? { draftId: draft.id, processed: draft.processed, evidence: draft.rawPayload } : null };
    });
  }

  async approve(actor: string, itemId: string, draftId: string) {
    actor = typeof actor === 'string' ? actor.toLowerCase() : '';
    itemId = itemId.toLowerCase();
    return this.db.transaction(async tx => {
      const { item, receipt, meta, promoter, campaign } = await this.context(tx, itemId, actor);
      const [draft] = await tx.select().from(s.billingProviderEvents).where(and(eq(s.billingProviderEvents.id, draftId),
        eq(s.billingProviderEvents.provider, 'paystack'), eq(s.billingProviderEvents.reference, `internal.ad.clearance:${itemId}`))).for('update');
      const proof = draft?.rawPayload as any;
      if (!draft || proof?.version !== 3 || proof.itemId !== itemId || proof.amountUsdCents !== item.earnedUsdCents ||
        proof.billedUsdCents !== item.billedUsdCents || !proof.evidenceId || proof.preparedBy === actor) throw new ForbiddenException('Independent matching clearance review required');
      await this.authorize(proof.preparedBy, tx);
      if ([promoter.userId, campaign.advertiserId].includes(proof.preparedBy)) throw new ForbiddenException('Financial beneficiaries cannot review their settlement');
      if (draft.processed && item.clearanceStatus === 'cleared' && receipt.status === 'completed') return { itemId, status: 'cleared', replayed: true };
      if (draft.processed || item.clearanceStatus !== 'pending' || receipt.status !== 'pending') throw new ConflictException('Clearance state requires reconciliation');
      if (!promoter.isActive || promoter.isSuspended) throw new ConflictException('Publisher is not eligible for clearance');
      const [beneficiary] = await tx.select({ status: s.users.status }).from(s.users).where(eq(s.users.id, promoter.userId)).for('share');
      if (beneficiary?.status !== 'ACTIVE') throw new ConflictException('Publisher account is not active');
      const [batch] = await tx.select().from(s.adsSettlementBatches).where(eq(s.adsSettlementBatches.id, item.batchId));
      const [spend] = await tx.select().from(s.billingTransactions).where(eq(s.billingTransactions.reference, `ads-spend-v3-${item.batchId}`));
      if (batch?.status !== 'completed' || spend?.status !== 'completed' || spend.type !== 'ads_spend' || spend.amountUsdCents !== batch.totalDebitedUsdCents) {
        throw new ConflictException('Funded batch receipt required');
      }
      // Review covers all preceding claimed events for this publisher/escrow, including carried fractions.
      const claims = await tx.select({ event: s.adsInteractions }).from(s.adsSettlementClaims)
        .innerJoin(s.adsInteractions, eq(s.adsInteractions.id, s.adsSettlementClaims.interactionId))
        .where(and(eq(s.adsSettlementClaims.escrowId, meta.escrowId), eq(s.adsSettlementClaims.promoterId, promoter.id),
          // Keep PostgreSQL microsecond precision; a JS Date truncates this boundary.
          lte(s.adsSettlementClaims.createdAt, sql`(select created_at from ads_promoter_settlement_items where id = ${item.id})`)))
        .for('share', { of: s.adsInteractions });
      if (!claims.length || claims.some(({ event }) => !event.isValid || event.verificationVersion !== 2)) throw new ConflictException('Claimed activity requires fraud reconciliation');
      await tx.insert(s.billingWallets).values({ userId: promoter.userId }).onConflictDoNothing({ target: s.billingWallets.userId });
      const [wallet] = await tx.select().from(s.billingWallets).where(eq(s.billingWallets.userId, promoter.userId)).for('update');
      const balance = wallet.balanceUsdCents + item.earnedUsdCents;
      if (!Number.isSafeInteger(balance) || wallet.balanceUsdCents < 0 || balance > 2147483647) throw new ConflictException('Publisher wallet limit exceeded');
      const now = new Date();
      await tx.update(s.billingWallets).set({ balanceUsdCents: balance, version: sql`${s.billingWallets.version} + 1`, updatedAt: now }).where(eq(s.billingWallets.id, wallet.id));
      await tx.update(s.billingTransactions).set({ status: 'completed', balanceBeforeUsdCents: wallet.balanceUsdCents, balanceAfterUsdCents: balance,
        metadata: JSON.stringify({ ...meta, clearance: { draftId, preparedBy: proof.preparedBy, reviewedBy: actor, evidenceId: proof.evidenceId, clearedAt: now.toISOString() } }), updatedAt: now })
        .where(eq(s.billingTransactions.id, receipt.id));
      await tx.update(s.adsPromoterSettlementItems).set({ status: 'credited', clearanceStatus: 'cleared', clearedAt: now }).where(eq(s.adsPromoterSettlementItems.id, itemId));
      await tx.update(s.adsSettlementBatches).set({ totalCreditedUsdCents: sql`${s.adsSettlementBatches.totalCreditedUsdCents} + ${item.earnedUsdCents}` }).where(eq(s.adsSettlementBatches.id, item.batchId));
      await tx.update(s.billingProviderEvents).set({ processed: true, processedAt: now }).where(eq(s.billingProviderEvents.id, draft.id));
      return { itemId, status: 'cleared', replayed: false };
    });
  }
}
