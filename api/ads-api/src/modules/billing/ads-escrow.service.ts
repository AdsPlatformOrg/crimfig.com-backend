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

  private async requireCampaignOwner(campaignId: string, userId: string) {
    if (!userId) throw new NotFoundException('Campaign not found');
    const [campaign] = await this.db.select().from(adsCampaigns)
      .where(and(eq(adsCampaigns.id, campaignId), eq(adsCampaigns.advertiserId, userId))).limit(1);
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

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

    await this.requireCampaignOwner(campaignId, userId);
    if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents < 500) {
      throw new BadRequestException('Escrow requires at least 500 integer USD cents');
    }

    // Billing commits wallet, reservation and durable receipt atomically. Ads never writes money.
    return this.billingClient.reserveCampaignEscrow(userId, campaignId, amountUsdCents);
  }

  /** Release only through Billing after serving has stopped. Repeated calls return the receipt. */
  async releaseCampaignBudget(params: { campaignId: string; userId: string; reason?: string }) {
    await this.requireCampaignOwner(params.campaignId, params.userId);
    const escrow = await this.billingClient.releaseCampaignEscrow(params.userId, params.campaignId);
    return { message: 'Escrow release confirmed', escrow };
  }

  async changeCampaignStatus(campaignId: string, userId: string, status: 'active' | 'paused' | 'trash') {
    await this.requireCampaignOwner(campaignId, userId);
    return this.billingClient.changeCampaignStatus(userId, campaignId, status);
  }

  /**
   * Get escrow details for a campaign
   */
  async getCampaignEscrow(campaignId: string, userId: string) {
    await this.requireCampaignOwner(campaignId, userId);
    const [escrow] = await this.db
      .select()
      .from(adsCampaignEscrows)
      .where(and(eq(adsCampaignEscrows.campaignId, campaignId), eq(adsCampaignEscrows.userId, userId)))
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
          id: e.id,
          refundedUsd: e.refundedUsdCents / 100,
          burnPercent: e.allocatedUsdCents > 0 ? e.consumedUsdCents / e.allocatedUsdCents * 100 : 0,
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
