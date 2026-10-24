import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  rewardsFund,
  rewardsFundLedger,
  rewardsPointsBalances,
  rewardsPointsLedger,
  deferredRewardEntitlements,
  rewardsBadges,
} from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { RewardsFundService } from './rewards-fund.service';

export interface MilestoneDefinition {
  tier: number;
  key: string;
  badgeTitle: string;
  badgeIcon: string;
  pointsAwarded: number;
  usdEquivalent: number;
}

@Injectable()
export class PointsEngineService {
  private readonly logger = new Logger(PointsEngineService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly fundService: RewardsFundService,
  ) {}

  /**
   * Get or initialize a user's point balances row
   */
  async getOrCreateUserBalance(userId: string) {
    const [existing] = await this.db
      .select()
      .from(rewardsPointsBalances)
      .where(eq(rewardsPointsBalances.userId, userId))
      .limit(1);

    if (existing) return existing;

    const [created] = await this.db
      .insert(rewardsPointsBalances)
      .values({
        userId,
        pendingPoints: 0,
        availablePoints: 0,
        reservedPoints: 0,
        lifetimeEarnedPoints: 0,
        lifetimeRedeemedPoints: 0,
        accumulatedRewardMicrousd: 0,
      })
      .onConflictDoNothing({ target: rewardsPointsBalances.userId })
      .returning();

    if (created) return created;

    const [refetched] = await this.db
      .select()
      .from(rewardsPointsBalances)
      .where(eq(rewardsPointsBalances.userId, userId))
      .limit(1);
    return refetched;
  }

  /**
   * Award Category A Milestone (14 tiers).
   * Enforces 3-state lifecycle:
   * 1. Permanently unlocks prestige badge in rewards_badges.
   * 2. Checks global pause and user suspension.
   * 3. If Rewards Fund available_usd_cents has sufficient cash:
   *    Moves cash available -> funded_pending, issues points in state 'pending' (post-72h hold).
   * 4. If Rewards Fund cash is depleted:
   *    Enters ACHIEVED_UNFUNDED state: records in deferred_reward_entitlements without creating fake debt.
   */
  async awardMilestone(
    userId: string,
    milestone: MilestoneDefinition,
    sourceRef: string,
    idempotencyKey: string,
  ) {
    // 1. Check idempotency on points ledger
    const [existingLedger] = await this.db
      .select()
      .from(rewardsPointsLedger)
      .where(eq(rewardsPointsLedger.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existingLedger) {
      return { status: 'already_awarded', ledgerEntry: existingLedger };
    }

    // 2. Check suspension controls
    const isGlobalPaused = await this.fundService.isGlobalRewardsPaused();
    if (isGlobalPaused) {
      this.logger.warn(`Rewards globally paused. Milestone ${milestone.key} for user ${userId} deferred.`);
      return { status: 'paused_deferred' };
    }

    const userBalance = await this.getOrCreateUserBalance(userId);
    if (userBalance.isRewardsSuspended) {
      this.logger.warn(`User ${userId} rewards suspended. Milestone ${milestone.key} blocked.`);
      return { status: 'user_suspended' };
    }

    const cashRequiredCents = milestone.pointsAwarded; // 100 points = $1.00 USD (1 pt = 1 cent)
    const valuationMicrousd = cashRequiredCents * 10000;

    return await this.db.transaction(async (tx) => {
      // Always award permanent prestige badge
      await tx
        .insert(rewardsBadges)
        .values({
          userId,
          badgeKey: milestone.key,
          badgeTitle: milestone.badgeTitle,
          badgeIcon: milestone.badgeIcon,
          tier: milestone.tier,
        })
        .onConflictDoNothing();

      // Lock fund row for update
      const [fund] = await tx
        .select()
        .from(rewardsFund)
        .where(eq(rewardsFund.currency, 'USD'))
        .for('update');

      const awardableCents = Math.max(0, fund.availableUsdCents - fund.reserveFloorUsdCents);

      if (awardableCents >= cashRequiredCents) {
        // STATE 2: FUNDED_PENDING (cash reserved 1:1)
        const newAvailable = fund.availableUsdCents - cashRequiredCents;
        const newFundedPending = fund.fundedPendingUsdCents + cashRequiredCents;

        await tx
          .update(rewardsFund)
          .set({
            availableUsdCents: newAvailable,
            fundedPendingUsdCents: newFundedPending,
            version: sql`${rewardsFund.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(rewardsFund.id, fund.id));

        // Fund ledger entry
        await tx.insert(rewardsFundLedger).values({
          fundId: fund.id,
          type: 'allocate',
          amountCents: cashRequiredCents,
          fromBucket: 'available',
          toBucket: 'funded_pending',
          cashBalanceAfterCents: fund.cashBalanceUsdCents,
          availableAfterCents: newAvailable,
          allocatedAfterCents: fund.allocatedUsdCents,
          fundedPendingAfterCents: newFundedPending,
          sourceRef,
          description: `1:1 cash backing reserved for milestone ${milestone.key} (${milestone.pointsAwarded} pts)`,
        });

        // Points ledger entry
        const [ledgerEntry] = await tx
          .insert(rewardsPointsLedger)
          .values({
            lotId: `lot-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            userId,
            deltaPoints: milestone.pointsAwarded,
            state: 'pending',
            activityCode: milestone.key,
            sourceRef,
            idempotencyKey,
            valuationMicrousd,
            rateVersion: 1,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 365 days
          })
          .returning();

        // Update user materialized balance (pendingPoints)
        await tx
          .update(rewardsPointsBalances)
          .set({
            pendingPoints: sql`${rewardsPointsBalances.pendingPoints} + ${milestone.pointsAwarded}`,
            lifetimeEarnedPoints: sql`${rewardsPointsBalances.lifetimeEarnedPoints} + ${milestone.pointsAwarded}`,
            version: sql`${rewardsPointsBalances.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(rewardsPointsBalances.userId, userId));

        return {
          status: 'FUNDED_PENDING',
          pointsAwarded: milestone.pointsAwarded,
          badgeTitle: milestone.badgeTitle,
          ledgerEntry,
        };
      } else {
        // STATE 1: ACHIEVED_UNFUNDED (Record deferred entitlement without fake points)
        await tx
          .insert(deferredRewardEntitlements)
          .values({
            userId,
            rewardKey: milestone.key,
            pointsEntitled: milestone.pointsAwarded,
            usdEquivalentCents: cashRequiredCents,
            badgeTitle: milestone.badgeTitle,
            badgeIcon: milestone.badgeIcon,
            status: 'queued',
          })
          .onConflictDoNothing();

        return {
          status: 'ACHIEVED_UNFUNDED',
          pointsAwarded: 0,
          pointsEntitled: milestone.pointsAwarded,
          badgeTitle: milestone.badgeTitle,
          message: 'Prestige badge unlocked! Cash-backed points queued until fund is seeded.',
        };
      }
    });
  }

  /**
   * Promote pending points to available points after clearance hold (72 hours).
   * Moves cash funded_pending -> allocated in the Rewards Fund.
   */
  async clearPendingPoints(ledgerId: string) {
    return await this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(rewardsPointsLedger)
        .where(and(eq(rewardsPointsLedger.id, ledgerId), eq(rewardsPointsLedger.state, 'pending')))
        .for('update');

      if (!entry) return null;

      const cashCents = entry.deltaPoints;

      // Update fund
      const [fund] = await tx
        .select()
        .from(rewardsFund)
        .where(eq(rewardsFund.currency, 'USD'))
        .for('update');

      const newFundedPending = fund.fundedPendingUsdCents - cashCents;
      const newAllocated = fund.allocatedUsdCents + cashCents;

      await tx
        .update(rewardsFund)
        .set({
          fundedPendingUsdCents: newFundedPending,
          allocatedUsdCents: newAllocated,
          version: sql`${rewardsFund.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(rewardsFund.id, fund.id));

      // Update ledger
      await tx
        .update(rewardsPointsLedger)
        .set({
          state: 'available',
          clearedAt: new Date(),
        })
        .where(eq(rewardsPointsLedger.id, entry.id));

      // Update user balance
      await tx
        .update(rewardsPointsBalances)
        .set({
          pendingPoints: sql`${rewardsPointsBalances.pendingPoints} - ${entry.deltaPoints}`,
          availablePoints: sql`${rewardsPointsBalances.availablePoints} + ${entry.deltaPoints}`,
          version: sql`${rewardsPointsBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(rewardsPointsBalances.userId, entry.userId));

      return { success: true, pointsCleared: entry.deltaPoints };
    });
  }
}
