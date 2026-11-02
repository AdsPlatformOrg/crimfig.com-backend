import { fundedPolicy } from "./reward-program-policy";
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { DATABASE_TOKEN } from "../database/database.module";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@crimfig/database/schema";
import {
  rewardsFund,
  rewardsFundLedger,
  rewardsPointsBalances,
  rewardsPointsLedger,
  deferredRewardEntitlements,
  rewardsBadges,
} from "@crimfig/database/schema";
import { eq, sql, and, lte, desc } from "drizzle-orm";
import { RewardsFundService } from "./rewards-fund.service";

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
    if (
      !Number.isSafeInteger(milestone.pointsAwarded) ||
      milestone.pointsAwarded <= 0 ||
      !idempotencyKey ||
      !sourceRef
    )
      throw new BadRequestException(
        "Exact reward identity and positive integer points required",
      );
    // 1. Check idempotency on points ledger
    const [existingLedger] = await this.db
      .select()
      .from(rewardsPointsLedger)
      .where(eq(rewardsPointsLedger.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existingLedger) {
      if (
        existingLedger.userId !== userId ||
        existingLedger.sourceRef !== sourceRef ||
        existingLedger.activityCode !== milestone.key ||
        existingLedger.deltaPoints !== milestone.pointsAwarded
      )
        throw new ConflictException("Reward identity changed");
      return { status: "already_awarded", ledgerEntry: existingLedger };
    }

    // 2. Check suspension controls
    const isGlobalPaused = await this.fundService.isGlobalRewardsPaused();
    if (isGlobalPaused) {
      this.logger.warn(
        `Rewards globally paused. Milestone ${milestone.key} for user ${userId} deferred.`,
      );
      return { status: "paused_deferred" };
    }

    const userBalance = await this.getOrCreateUserBalance(userId);
    if (userBalance.isRewardsSuspended) {
      this.logger.warn(
        `User ${userId} rewards suspended. Milestone ${milestone.key} blocked.`,
      );
      return { status: "user_suspended" };
    }

    const cashRequiredCents = milestone.pointsAwarded; // 100 points = $1.00 USD (1 pt = 1 cent)
    const valuationMicrousd = cashRequiredCents * 10000;

    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='5s'`);
      await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('rewards-fund:USD',0))`,
      );
      const [prior] = await tx
        .select()
        .from(rewardsPointsLedger)
        .where(eq(rewardsPointsLedger.idempotencyKey, idempotencyKey))
        .limit(1);
      if (prior) {
        if (
          prior.userId !== userId ||
          prior.sourceRef !== sourceRef ||
          prior.activityCode !== milestone.key ||
          prior.deltaPoints !== milestone.pointsAwarded
        )
          throw new ConflictException("Reward identity changed");
        return { status: "already_awarded", ledgerEntry: prior };
      }

      const [activeSettings] = await tx
        .select()
        .from(schema.rewardsFundSettings)
        .where(
          and(
            eq(schema.rewardsFundSettings.isActive, true),
            lte(schema.rewardsFundSettings.effectiveFrom, new Date()),
          ),
        )
        .orderBy(desc(schema.rewardsFundSettings.version))
        .limit(1);
      if (!activeSettings || new Set(activeSettings.approvedBy).size < 2)
        throw new ConflictException("Approved rewards settings required");
      const [currentBalance] = await tx
        .select()
        .from(rewardsPointsBalances)
        .where(eq(rewardsPointsBalances.userId, userId))
        .for("update");
      if (
        activeSettings.adsRewardsGlobalPaused ||
        currentBalance?.isRewardsSuspended
      )
        return { status: "paused_deferred" };
      if (milestone.key.startsWith("promo_")) {
        const [awarded] = await tx
          .select()
          .from(rewardsPointsLedger)
          .where(
            and(
              eq(rewardsPointsLedger.userId, userId),
              eq(rewardsPointsLedger.activityCode, milestone.key),
            ),
          )
          .limit(1);
        if (awarded) return { status: "already_awarded", ledgerEntry: awarded };
      }
      const [queued] = await tx
        .select()
        .from(deferredRewardEntitlements)
        .where(
          and(
            eq(deferredRewardEntitlements.userId, userId),
            eq(deferredRewardEntitlements.rewardKey, milestone.key),
          ),
        )
        .limit(1);
      if (queued)
        return {
          status: "ACHIEVED_UNFUNDED",
          pointsAwarded: 0,
          pointsEntitled: queued.pointsEntitled,
        };
      const caps: any = await tx.execute(
        sql`SELECT coalesce(sum(delta_points) FILTER(WHERE (earned_at AT TIME ZONE 'UTC')::date=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)::text AS daily,coalesce(sum(delta_points),0)::text AS monthly,coalesce(sum(delta_points) FILTER(WHERE user_id=${userId} AND (earned_at AT TIME ZONE 'UTC')::date=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)::text AS user_daily,coalesce(sum(delta_points) FILTER(WHERE user_id=${userId}),0)::text AS user_monthly FROM rewards_points_ledger WHERE delta_points>0 AND activity_code<>'reward_clearance_available' AND date_trunc('month',earned_at AT TIME ZONE 'UTC')=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')`,
      );
      const usage = (caps.rows ?? caps)[0];
      let capReached =
        BigInt(usage.daily) + BigInt(milestone.pointsAwarded) >
          BigInt(activeSettings.dailyEmissionCapPoints) ||
        BigInt(usage.monthly) + BigInt(milestone.pointsAwarded) >
          BigInt(activeSettings.monthlyEmissionCapPoints) ||
        BigInt(usage.user_daily) + BigInt(milestone.pointsAwarded) >
          BigInt(activeSettings.perUserDailyCapPoints) ||
        BigInt(usage.user_monthly) + BigInt(milestone.pointsAwarded) >
          BigInt(activeSettings.perUserMonthlyCapPoints);
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
        .where(eq(rewardsFund.currency, "USD"))
        .for("update");

      if (
        !fund ||
        ![
          fund.cashBalanceUsdCents,
          fund.availableUsdCents,
          fund.allocatedUsdCents,
          fund.fundedPendingUsdCents,
        ].every((v) => Number.isSafeInteger(v) && v >= 0) ||
        fund.cashBalanceUsdCents !==
          fund.availableUsdCents +
            fund.allocatedUsdCents +
            fund.fundedPendingUsdCents
      )
        throw new ConflictException("Rewards Fund needs reconciliation");
      const safetyFloor = Math.max(
        fund.reserveFloorUsdCents,
        activeSettings.reserveFloorMinCents,
        Math.ceil(
          (fund.cashBalanceUsdCents * activeSettings.reserveFloorPercent) / 100,
        ),
      );
      const awardableCents = Math.max(0, fund.availableUsdCents - safetyFloor);
      const clock: any = await tx.execute(sql`SELECT clock_timestamp() AS now`);
      const now = new Date((clock.rows ?? clock)[0].now),
        config = fundedPolicy();
      const reserves: any = await tx.execute(
        sql`SELECT coalesce(sum(a.amount_cents-(SELECT coalesce(sum(points),0) FROM reward_program_issues i WHERE i.allocation_id=a.id)),0)::text AS units FROM reward_program_allocations a WHERE a.approved_at IS NOT NULL`,
      );
      const base =
        BigInt(fund.availableUsdCents) +
        BigInt((reserves.rows ?? reserves)[0].units) -
        BigInt(safetyFloor);
      for (const kind of ["day", "month"] as const) {
        const period = now.toISOString().slice(0, kind === "day" ? 10 : 7),
          percent =
            kind === "day"
              ? config.dailyEmissionPercent
              : config.monthlyEmissionPercent,
          absolute =
            kind === "day"
              ? activeSettings.dailyEmissionCapPoints
              : activeSettings.monthlyEmissionCapPoints,
          calculated = ((base > 0n ? base : 0n) * BigInt(percent)) / 100n,
          cap = calculated < BigInt(absolute) ? calculated : BigInt(absolute);
        await tx.execute(
          sql`INSERT INTO reward_issuance_periods(period,kind,cap_points,snapshot) VALUES(${period},${kind},${Number(cap)},${JSON.stringify({ settingsVersion: activeSettings.version, base: base.toString(), percent, absolute })}::jsonb) ON CONFLICT DO NOTHING`,
        );
        const budget: any = await tx.execute(
          sql`SELECT cap_points FROM reward_issuance_periods WHERE period=${period} AND kind=${kind}`,
        );
        if (
          BigInt(kind === "day" ? usage.daily : usage.monthly) +
            BigInt(milestone.pointsAwarded) >
          BigInt((budget.rows ?? budget)[0].cap_points)
        )
          capReached = true;
      }

      if (!capReached && awardableCents >= cashRequiredCents) {
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
          type: "allocate",
          amountCents: cashRequiredCents,
          fromBucket: "available",
          toBucket: "funded_pending",
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
            state: "pending",
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
          status: "FUNDED_PENDING",
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
            status: "queued",
          })
          .onConflictDoNothing();

        return {
          status: "ACHIEVED_UNFUNDED",
          pointsAwarded: 0,
          pointsEntitled: milestone.pointsAwarded,
          badgeTitle: milestone.badgeTitle,
          message:
            "Prestige badge unlocked! Cash-backed points queued until fund is seeded.",
        };
      }
    });
  }

  /**
   * Promote pending points to available points after clearance hold (72 hours).
   * Moves cash funded_pending -> allocated in the Rewards Fund.
   */
  async clearPendingPoints(_ledgerId: string) {
    // This legacy signature carries neither reviewer identity nor audited proof.
    // Keep it fail-closed; the explicit program clearance route appends transitions.
    throw new ConflictException(
      "Use the granted, source-bound rewards clearance workflow",
    );
  }
}
