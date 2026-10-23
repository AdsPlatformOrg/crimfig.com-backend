import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsCampaigns, adsCampaignEscrows, billingTransactions, billingWallets } from '@crimfig/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';

const MAX_CENTS = 2147483647; // Wallet/transaction columns are PostgreSQL int4.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Billing owns BOTH wallet and campaign escrow writes in one shared PostgreSQL transaction.
 * No network calls, providers, FX queries or Ads-owned money writes occur inside this boundary.
 * Existing unreceipted escrow rows require operator reconciliation, never automatic adoption.
 */
@Injectable()
export class CampaignEscrowService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  private key(escrowId: string, action: 'reserve' | 'release', allocated: number) {
    return `ads-escrow:v2:${escrowId}:${action}:${allocated}`;
  }

  async change(userId: string, campaignId: string, action: 'reserve' | 'release', amountUsdCents?: number, targetStatus?: 'active' | 'paused' | 'trash') {
    if (!uuid.test(userId) || !uuid.test(campaignId)) throw new BadRequestException('Valid owner and campaign IDs are required');
    if (action !== 'reserve' && action !== 'release') throw new BadRequestException('Unsupported escrow operation');
    if (targetStatus && ((targetStatus === 'active') !== (action === 'reserve'))) throw new BadRequestException('Campaign status and escrow operation disagree');
    if (targetStatus && !['active', 'paused', 'trash'].includes(targetStatus)) throw new BadRequestException('Unsupported campaign status');
    if (!targetStatus && action === 'reserve' && (!Number.isSafeInteger(amountUsdCents) || amountUsdCents! < 500 || amountUsdCents! > MAX_CENTS)) {
      throw new BadRequestException('Escrow requires 500 to 2147483647 integer USD cents');
    }
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      // Lock before every snapshot. This also serializes creation when no escrow row exists.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${campaignId}`}, 0))`);
      const [campaign] = await tx.select().from(adsCampaigns)
        .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, userId))).for('update');
      if (!campaign) throw new NotFoundException('Campaign not found');
      if (targetStatus && (campaign.status === 'suspended' || (targetStatus === 'active' && campaign.moderationStatus !== 'approved'))) {
        throw new ConflictException('Campaign requires staff moderation before this transition');
      }
      const finish = async (result: any) => {
        if (!targetStatus) return result;
        if (campaign.status === targetStatus) return { ...result, campaign };
        const [updated] = await tx.update(adsCampaigns).set({ status: targetStatus, updatedAt: new Date() })
          .where(eq(adsCampaigns.id, campaignId)).returning();
        return { ...result, campaign: updated };
      };
      if (targetStatus === 'active') amountUsdCents = campaign.remainingBudgetUsdCents;
      if (action === 'reserve' && (!Number.isSafeInteger(amountUsdCents) || amountUsdCents! < 500 || amountUsdCents! > MAX_CENTS)) {
        throw new BadRequestException('Campaign requires 500 to 2147483647 integer USD cents to activate');
      }
      if (action === 'reserve' && (['suspended', 'trash'].includes(campaign.status) || amountUsdCents! > campaign.remainingBudgetUsdCents)) {
        throw new ConflictException('Campaign cannot reserve this budget');
      }
      const rows = await tx.select().from(adsCampaignEscrows).where(eq(adsCampaignEscrows.campaignId, campaignId)).for('update');
      if (rows.length > 1 || (rows[0] && rows[0].userId !== userId)) {
        throw new ConflictException('Escrow records require reconciliation');
      }
      let escrow = rows[0];
      const receipt = async (operationId: string) => {
        const [record] = await tx.select().from(billingTransactions).where(eq(billingTransactions.idempotencyKey, operationId));
        let metadata: any;
        try { metadata = JSON.parse(record?.metadata || '{}'); } catch { metadata = {}; }
        if (!record || metadata.version !== 2 || metadata.kind !== 'campaign_escrow' ||
            metadata.campaignId !== campaignId || metadata.escrowId !== escrow.id ||
            metadata.allocatedUsdCents !== escrow.allocatedUsdCents ||
            metadata.action !== (operationId.includes(':reserve:') ? 'reserve' : 'release') ||
            !Number.isInteger(record.amountUsdCents) || record.amountUsdCents < 0 || record.amountUsdCents > MAX_CENTS ||
            record.status !== 'completed' || record.userId !== userId || record.provider !== 'internal' ||
            record.type !== (operationId.includes(':reserve:') ? 'internal_debit' : 'internal_credit')) {
          throw new ConflictException('Escrow has no confirmed Billing receipt; reconciliation required');
        }
        return record;
      };
      if (escrow) {
        for (const value of [escrow.allocatedUsdCents, escrow.consumedUsdCents, escrow.refundedUsdCents]) {
          if (!Number.isSafeInteger(value) || value < 0) throw new ConflictException('Invalid escrow balances; reconciliation required');
        }
        if (escrow.consumedUsdCents + escrow.refundedUsdCents > escrow.allocatedUsdCents) {
          throw new ConflictException('Escrow exceeds its reservation; reconciliation required');
        }
        const reserved = await receipt(this.key(escrow.id, 'reserve', escrow.allocatedUsdCents));
        if (action === 'reserve' && escrow.status === 'active') {
          if (reserved.amountUsdCents !== amountUsdCents) throw new ConflictException('An active reservation cannot be resized');
          return finish({ escrow, operationId: reserved.idempotencyKey, transactionId: reserved.id, replayed: true });
        }
        if (escrow.status === 'released') {
          const released = await receipt(this.key(escrow.id, 'release', escrow.allocatedUsdCents));
          if (action === 'release') return finish({ escrow, operationId: released.idempotencyKey, transactionId: released.id, replayed: true });
        }
        if (action === 'reserve' && escrow.status !== 'released') {
          throw new ConflictException('Existing escrow must be reconciled and released before another reservation');
        }
      } else if (action === 'release') {
        if (targetStatus) return finish({ escrow: null, operationId: null, transactionId: null, replayed: true });
        throw new NotFoundException('Campaign escrow not found');
      }
      if (action === 'release' && campaign.status === 'active' && !targetStatus) {
        throw new ConflictException('Pause the campaign before releasing its reservation');
      }
      // Concurrent reservations for different campaigns serialize on this wallet row.
      await tx.insert(billingWallets).values({ userId, balanceUsdCents: 0, lockedUsdCents: 0 }).onConflictDoNothing({ target: billingWallets.userId });
      const [wallet] = await tx.select().from(billingWallets).where(eq(billingWallets.userId, userId)).for('update');
      if (!wallet || !Number.isInteger(wallet.balanceUsdCents) || !Number.isInteger(wallet.lockedUsdCents) ||
          wallet.balanceUsdCents < 0 || wallet.lockedUsdCents < 0) throw new ConflictException('Invalid wallet; reconciliation required');
      const amount = action === 'reserve' ? amountUsdCents! : escrow!.allocatedUsdCents - escrow!.consumedUsdCents - escrow!.refundedUsdCents;
      const available = wallet.balanceUsdCents + (action === 'reserve' ? -amount : amount);
      const locked = wallet.lockedUsdCents + (action === 'reserve' ? amount : -amount);
      if (available < 0 || locked < 0 || available > MAX_CENTS || locked > MAX_CENTS) {
        throw new ConflictException('Insufficient wallet funds or wallet limit exceeded');
      }
      const now = new Date();
      if (action === 'reserve') {
        const allocated = (escrow?.allocatedUsdCents || 0) + amount;
        if (!Number.isSafeInteger(allocated)) throw new ConflictException('Escrow ledger limit exceeded');
        if (escrow) {
          [escrow] = await tx.update(adsCampaignEscrows).set({ allocatedUsdCents: allocated, status: 'active', updatedAt: now })
            .where(eq(adsCampaignEscrows.id, escrow.id)).returning();
        } else {
          [escrow] = await tx.insert(adsCampaignEscrows).values({ campaignId, userId, allocatedUsdCents: allocated, consumedUsdCents: 0, refundedUsdCents: 0, status: 'active' }).returning();
        }
      } else {
        [escrow] = await tx.update(adsCampaignEscrows).set({ refundedUsdCents: escrow!.refundedUsdCents + amount, status: 'released', updatedAt: now })
          .where(eq(adsCampaignEscrows.id, escrow!.id)).returning();
      }
      await tx.update(billingWallets).set({ balanceUsdCents: available, lockedUsdCents: locked, version: sql`${billingWallets.version} + 1`, updatedAt: now })
        .where(eq(billingWallets.userId, userId));
      const operationId = this.key(escrow.id, action, escrow.allocatedUsdCents);
      const [record] = await tx.insert(billingTransactions).values({
        userId, type: action === 'reserve' ? 'internal_debit' : 'internal_credit', status: 'completed', provider: 'internal',
        amountUsdCents: amount, balanceBeforeUsdCents: wallet.balanceUsdCents, balanceAfterUsdCents: available,
        idempotencyKey: operationId,
        metadata: JSON.stringify({ version: 2, kind: 'campaign_escrow', action, campaignId, escrowId: escrow.id,
          allocatedUsdCents: escrow.allocatedUsdCents, lockedBeforeUsdCents: wallet.lockedUsdCents, lockedAfterUsdCents: locked,
          description: action === 'reserve' ? 'Campaign budget reserved' : 'Campaign budget released' }),
      }).returning();
      return finish({ escrow, operationId, transactionId: record.id, replayed: false });
    }, { isolationLevel: 'read committed' });
  }
}
