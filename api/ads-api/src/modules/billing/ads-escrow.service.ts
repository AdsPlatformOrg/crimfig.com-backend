import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsCampaignEscrows, adsCampaigns } from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import { BillingEcosystemClient } from './billing-ecosystem.client';

@Injectable()
export class AdsEscrowService {
  private readonly logger = new Logger(AdsEscrowService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly billingClient: BillingEcosystemClient,
  ) {}

  /**
   * Lock campaign budget into escrow upon campaign activation
   */
  async lockCampaignBudget(params: {
    campaignId: string;
    userId: string;
    amountUsdCents: number;
    campaignTitle?: string;
  }) {
    const { campaignId, userId, amountUsdCents, campaignTitle } = params;

    // 1. Verify user wallet balance has enough available funds
    const wallet = await this.billingClient.getWalletBalance(userId);
    if (wallet.availableUsdCents < amountUsdCents) {
      throw new BadRequestException(
        `Insufficient available wallet balance. Required: $${(amountUsdCents / 100).toFixed(2)}, Available: $${(
          wallet.availableUsdCents / 100
        ).toFixed(2)}`,
      );
    }

    // 2. Lock the funds in the unified billing wallet
    const reason = `Escrow lock for campaign "${campaignTitle || campaignId}"`;
    await this.billingClient.lockFunds(userId, amountUsdCents, reason);

    // 3. Upsert escrow ledger record
    const existing = await this.db
      .select()
      .from(adsCampaignEscrows)
      .where(and(eq(adsCampaignEscrows.campaignId, campaignId), eq(adsCampaignEscrows.userId, userId)))
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await this.db
        .update(adsCampaignEscrows)
        .set({
          allocatedUsdCents: amountUsdCents,
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(adsCampaignEscrows.id, existing[0].id))
        .returning();

      return updated;
    }

    const [escrow] = await this.db
      .insert(adsCampaignEscrows)
      .values({
        campaignId,
        userId,
        allocatedUsdCents: amountUsdCents,
        consumedUsdCents: 0,
        refundedUsdCents: 0,
        status: 'active',
      })
      .returning();

    this.logger.log(`Escrow locked: $${(amountUsdCents / 100).toFixed(2)} for campaign ${campaignId}`);
    return escrow;
  }

  /**
   * Release unconsumed escrow funds back to available wallet balance
   * (e.g., when advertiser pauses, archives, or deletes a campaign)
   */
  async releaseCampaignBudget(params: {
    campaignId: string;
    userId: string;
    reason?: string;
  }) {
    const { campaignId, userId, reason } = params;

    const [escrow] = await this.db
      .select()
      .from(adsCampaignEscrows)
      .where(and(eq(adsCampaignEscrows.campaignId, campaignId), eq(adsCampaignEscrows.userId, userId)))
      .limit(1);

    if (!escrow) {
      throw new NotFoundException(`No escrow record found for campaign ${campaignId}`);
    }

    if (escrow.status === 'released') {
      return { message: 'Escrow already released', escrow };
    }

    const unconsumedCents = escrow.allocatedUsdCents - escrow.consumedUsdCents - escrow.refundedUsdCents;

    if (unconsumedCents > 0) {
      const unlockReason = reason || `Escrow release for campaign ${campaignId}`;
      await this.billingClient.unlockFunds(userId, unconsumedCents, unlockReason);
    }

    const [updated] = await this.db
      .update(adsCampaignEscrows)
      .set({
        refundedUsdCents: escrow.refundedUsdCents + (unconsumedCents > 0 ? unconsumedCents : 0),
        status: 'released',
        updatedAt: new Date(),
      })
      .where(eq(adsCampaignEscrows.id, escrow.id))
      .returning();

    this.logger.log(`Escrow released: $${(unconsumedCents / 100).toFixed(2)} refunded for campaign ${campaignId}`);
    return {
      message: 'Escrow released successfully',
      refundedUsdCents: unconsumedCents,
      escrow: updated,
    };
  }

  /**
   * Get escrow details for a campaign
   */
  async getCampaignEscrow(campaignId: string) {
    const [escrow] = await this.db
      .select()
      .from(adsCampaignEscrows)
      .where(eq(adsCampaignEscrows.campaignId, campaignId))
      .limit(1);

    if (!escrow) {
      return null;
    }

    const remainingCents = escrow.allocatedUsdCents - escrow.consumedUsdCents - escrow.refundedUsdCents;
    const burnPercent = escrow.allocatedUsdCents > 0 ? (escrow.consumedUsdCents / escrow.allocatedUsdCents) * 100 : 0;

    return {
      ...escrow,
      remainingUsdCents: Math.max(0, remainingCents),
      allocatedUsd: escrow.allocatedUsdCents / 100,
      consumedUsd: escrow.consumedUsdCents / 100,
      remainingUsd: Math.max(0, remainingCents) / 100,
      refundedUsd: escrow.refundedUsdCents / 100,
      burnPercent: Number(burnPercent.toFixed(1)),
    };
  }

  /**
   * Get combined billing overview for advertiser / promoter
   */
  async getBillingOverview(userId: string) {
    const wallet = await this.billingClient.getWalletBalance(userId);

    // Sum active locked escrows across active campaigns
    const escrows = await this.db
      .select()
      .from(adsCampaignEscrows)
      .where(and(eq(adsCampaignEscrows.userId, userId), eq(adsCampaignEscrows.status, 'active')));

    const totalEscrowLockedCents = escrows.reduce(
      (sum, e) => sum + (e.allocatedUsdCents - e.consumedUsdCents - e.refundedUsdCents),
      0,
    );

    const totalConsumedCents = escrows.reduce((sum, e) => sum + e.consumedUsdCents, 0);

    return {
      wallet: {
        availableUsdCents: wallet.availableUsdCents,
        availableUsd: wallet.availableUsdCents / 100,
        lockedUsdCents: wallet.lockedUsdCents,
        lockedUsd: wallet.lockedUsdCents / 100,
        totalUsdCents: wallet.totalUsdCents,
        totalUsd: wallet.totalUsdCents / 100,
        exchangeRate: wallet.exchangeRate,
        estimatedNgn: wallet.estimatedAvailableNgn,
      },
      campaignEscrows: {
        activeCampaignsCount: escrows.length,
        totalLockedUsdCents: totalEscrowLockedCents,
        totalLockedUsd: totalEscrowLockedCents / 100,
        totalBurnedUsdCents: totalConsumedCents,
        totalBurnedUsd: totalConsumedCents / 100,
        items: escrows.map((e) => ({
          campaignId: e.campaignId,
          allocatedUsd: e.allocatedUsdCents / 100,
          consumedUsd: e.consumedUsdCents / 100,
          remainingUsd: (e.allocatedUsdCents - e.consumedUsdCents - e.refundedUsdCents) / 100,
          status: e.status,
          updatedAt: e.updatedAt,
        })),
      },
    };
  }
}
