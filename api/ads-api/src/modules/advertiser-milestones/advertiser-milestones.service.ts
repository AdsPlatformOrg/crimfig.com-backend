import { Injectable, Inject, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  advertiserPromoBudget,
  advertiserAchievements,
  adsCampaigns,
} from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import financialConstants from '@crimfig/shared/src/config/financial-constants.json';

@Injectable()
export class AdvertiserMilestonesService {
  private readonly logger = new Logger(AdvertiserMilestonesService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get or initialize advertiser promotional budget singleton
   */
  async getOrCreatePromoBudget() {
    const [budget] = await this.db.select().from(advertiserPromoBudget).limit(1);
    if (budget) return budget;

    const [created] = await this.db
      .insert(advertiserPromoBudget)
      .values({
        totalAllocatedCents: 1000000, // $10,000 USD default authorized promotional allocation
        issuedBonusCreditsCents: 0,
        consumedBonusCreditsCents: 0,
        remainingPromoBudgetCents: 1000000,
        isIssuanceHalted: false,
      })
      .returning();

    return created;
  }

  /**
   * List advertiser's achievements and bonus credits
   */
  async getAdvertiserAchievements(advertiserId: string) {
    const achievements = await this.db
      .select()
      .from(advertiserAchievements)
      .where(eq(advertiserAchievements.advertiserId, advertiserId))
      .orderBy(desc(advertiserAchievements.achievedAt));

    const totalBonusCreditRemainingCents = achievements.reduce(
      (sum, a) => sum + (a.isClawedBack ? 0 : a.bonusCreditRemainingCents),
      0,
    );

    return {
      achievements,
      totalBonusCreditRemainingCents,
      totalBonusCreditRemainingUsd: (totalBonusCreditRemainingCents / 100).toFixed(2),
      definitions: financialConstants.advertiserAchievements,
    };
  }

  /**
   * Evaluate and award Category A Milestones (A1 - A4)
   * A1: First Campaign (min $5 spend, cleared) -> $5.00 bonus ad credit
   * A2: Consistent Advertiser (>= 5 campaigns, 0 strikes) -> $15.00 bonus ad credit
   * A3: Growth Advertiser (>= $500 spend, >= 10 campaigns) -> $50.00 bonus ad credit
   * A4: Trusted Advertiser (>= $2,500 spend) -> $150.00 bonus ad credit
   */
  async evaluateCategoryAMilestones(advertiserId: string) {
    const budget = await this.getOrCreatePromoBudget();
    if (budget.isIssuanceHalted) {
      this.logger.warn(`Advertiser promotional budget issuance halted. Skipping evaluation.`);
      return { status: 'budget_halted' };
    }

    // Get advertiser campaigns
    const campaigns = await this.db
      .select()
      .from(adsCampaigns)
      .where(eq(adsCampaigns.advertiserId, advertiserId));

    const totalCampaigns = campaigns.length;
    const totalSpendCents = campaigns.reduce((acc, c) => acc + Math.max(0, (c.budgetUsdCents || 0) - (c.remainingBudgetUsdCents || 0)), 0);

    const existingAchievements = await this.db
      .select()
      .from(advertiserAchievements)
      .where(eq(advertiserAchievements.advertiserId, advertiserId));

    const existingTiers = new Set(existingAchievements.map((a) => a.tier));
    const newlyAwarded: (typeof advertiserAchievements.$inferSelect)[] = [];

    const awardTier = async (tier: any, title: string, icon: string, bonusCents: number, validityDays: number) => {
      if (existingTiers.has(tier)) return;

      if (budget.remainingPromoBudgetCents < bonusCents) {
        this.logger.warn(`Insufficient remaining promotional budget to award tier ${tier}`);
        return;
      }

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + validityDays);

      const [achievement] = await this.db
        .insert(advertiserAchievements)
        .values({
          advertiserId,
          tier,
          badgeTitle: title,
          badgeIcon: icon,
          bonusCreditCents: bonusCents,
          bonusCreditRemainingCents: bonusCents,
          creditExpiresAt: expiresAt,
          qualifyingSpendCents: totalSpendCents,
          qualifyingCampaignCount: totalCampaigns,
        })
        .returning();

      // Deduct from promo budget atomically
      await this.db
        .update(advertiserPromoBudget)
        .set({
          issuedBonusCreditsCents: sql`${advertiserPromoBudget.issuedBonusCreditsCents} + ${bonusCents}`,
          remainingPromoBudgetCents: sql`${advertiserPromoBudget.remainingPromoBudgetCents} - ${bonusCents}`,
          updatedAt: new Date(),
        })
        .where(eq(advertiserPromoBudget.id, budget.id));

      newlyAwarded.push(achievement);
    };

    // A1: First Campaign
    if (totalCampaigns >= 1 && totalSpendCents >= 500) {
      await awardTier('A1_FIRST_CAMPAIGN', 'First Campaign', '🛡️', 500, 90);
    }
    // A2: Consistent
    if (totalCampaigns >= 5) {
      await awardTier('A2_CONSISTENT', 'Consistent Advertiser', '🥈', 1500, 180);
    }
    // A3: Growth
    if (totalCampaigns >= 10 && totalSpendCents >= 50000) {
      await awardTier('A3_GROWTH', 'Growth Advertiser', '💎', 5000, 365);
    }
    // A4: Trusted
    if (totalSpendCents >= 250000) {
      await awardTier('A4_TRUSTED', 'Trusted Advertiser', '👑', 15000, 365);
    }

    return {
      status: 'evaluated',
      newlyAwarded,
      totalCampaigns,
      totalSpendCents,
    };
  }
}
