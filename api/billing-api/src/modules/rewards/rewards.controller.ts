import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Query,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { PointsEngineService } from './points-engine.service';
import { RewardsFundService } from './rewards-fund.service';
import { RedemptionService } from './redemption.service';
import { GrowthReferralService } from './growth-referral.service';
import { DATABASE_TOKEN } from '../database/database.module';
import { Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { eq, desc } from 'drizzle-orm';

@Controller('rewards')
export class RewardsController {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly pointsEngine: PointsEngineService,
    private readonly fundService: RewardsFundService,
    private readonly redemptionService: RedemptionService,
    private readonly referralService: GrowthReferralService,
  ) {}

  /**
   * User Rewards Overview: points balance, badges, and ledger history
   */
  @Get('me')
  async getMyRewards(@Req() req: any) {
    const userId = req.user.sub;
    const balance = await this.pointsEngine.getOrCreateUserBalance(userId);
    const badges = await this.db
      .select()
      .from(schema.rewardsBadges)
      .where(eq(schema.rewardsBadges.userId, userId));

    const ledger = await this.db
      .select()
      .from(schema.rewardsPointsLedger)
      .where(eq(schema.rewardsPointsLedger.userId, userId))
      .orderBy(desc(schema.rewardsPointsLedger.createdAt))
      .limit(50);

    const deferred = await this.db
      .select()
      .from(schema.deferredRewardEntitlements)
      .where(eq(schema.deferredRewardEntitlements.userId, userId));

    return {
      availablePoints: balance.availablePoints,
      pendingPoints: balance.pendingPoints,
      reservedPoints: balance.reservedPoints,
      usdValueEquivalent: (balance.availablePoints / 100).toFixed(2),
      lifetimeEarned: balance.lifetimeEarnedPoints,
      lifetimeRedeemed: balance.lifetimeRedeemedPoints,
      isSuspended: balance.isRewardsSuspended,
      badges,
      deferredEntitlements: deferred,
      recentLedger: ledger,
    };
  }

  /**
   * Redeem points to wallet credit
   */
  @Post('redeem')
  async redeemPoints(
    @Req() req: any,
    @Body() body: { points: number; idempotencyKey: string },
  ) {
    const userId = req.user.sub;
    if (!body.points || !body.idempotencyKey) {
      throw new BadRequestException('points and idempotencyKey are required');
    }

    return await this.redemptionService.redeemToWallet(
      userId,
      body.points,
      body.idempotencyKey,
    );
  }

  /**
   * User referral code & statistics
   */
  @Get('referrals/me')
  async getMyReferrals(@Req() req: any) {
    const userId = req.user.sub;
    return await this.referralService.getUserReferralStats(userId);
  }

  /**
   * Generate tracked share link
   */
  @Post('share-link')
  async createShareLink(
    @Req() req: any,
    @Body() body: { channel: string; targetPath?: string },
  ) {
    const userId = req.user.sub;
    if (!body.channel) {
      throw new BadRequestException('channel is required');
    }

    return await this.referralService.createShareLink(
      userId,
      body.channel,
      body.targetPath ?? '/',
    );
  }

  /**
   * Rewards Leaderboard (top earners, masked user identities)
   */
  @Get('leaderboard')
  async getLeaderboard() {
    const topBalances = await this.db
      .select({
        userId: schema.rewardsPointsBalances.userId,
        points: schema.rewardsPointsBalances.lifetimeEarnedPoints,
      })
      .from(schema.rewardsPointsBalances)
      .orderBy(desc(schema.rewardsPointsBalances.lifetimeEarnedPoints))
      .limit(20);

    return topBalances.map((item, idx) => ({
      rank: idx + 1,
      maskedUser: `user_...${item.userId.substring(item.userId.length - 4)}`,
      points: item.points,
      usdEquivalent: (item.points / 100).toFixed(2),
    }));
  }
}
