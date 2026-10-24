import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { rewardsFund, rewardsFundLedger, rewardsFundSettings, rewardsSettingsProposals, adsRewardsSuspensionAudit } from '@crimfig/database/schema';
import { eq, sql } from 'drizzle-orm';

@Injectable()
export class RewardsFundService {
  private readonly logger = new Logger(RewardsFundService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Get or initialize the singleton USD Rewards Fund row.
   */
  async getOrCreateFund(currency = 'USD') {
    const [existing] = await this.db
      .select()
      .from(rewardsFund)
      .where(eq(rewardsFund.currency, currency))
      .limit(1);

    if (existing) return existing;

    const [created] = await this.db
      .insert(rewardsFund)
      .values({
        currency,
        cashBalanceUsdCents: 0,
        allocatedUsdCents: 0,
        availableUsdCents: 0,
        fundedPendingUsdCents: 0,
        spentUsdCents: 0,
        reserveFloorUsdCents: 10000, // $100 buffer
        fractionalResidualMicrousd: 0,
      })
      .onConflictDoNothing({ target: rewardsFund.currency })
      .returning();

    if (created) return created;

    const [refetched] = await this.db
      .select()
      .from(rewardsFund)
      .where(eq(rewardsFund.currency, currency))
      .limit(1);
    return refetched;
  }

  /**
   * Check if global rewards issuance is paused.
   */
  async isGlobalRewardsPaused(): Promise<boolean> {
    const [settings] = await this.db
      .select()
      .from(rewardsFundSettings)
      .where(eq(rewardsFundSettings.isActive, true))
      .limit(1);

    return settings?.adsRewardsGlobalPaused ?? false;
  }

  /**
   * 10% Auto-Sweep from Settled Net Dynamic Pool (PLAN-0016 §5.2).
   * Exact integer microdollar accumulator arithmetic.
   * 10,000 microdollars = 1 integer USD cent. Whole cents are added to available_usd_cents.
   * Residual microdollars carry forward without rounding.
   */
  async sweepSettledDynamicPool(
    sourceBatchRef: string,
    netDynamicPoolCents: number,
    actorId?: string,
  ) {
    if (netDynamicPoolCents <= 0) return { sweptCents: 0, residualMicrousd: 0 };

    return await this.db.transaction(async (tx) => {
      // 1. Lock fund row for update
      const [fund] = await tx
        .select()
        .from(rewardsFund)
        .where(eq(rewardsFund.currency, 'USD'))
        .for('update');

      if (!fund) {
        throw new BadRequestException('Rewards Fund row not initialized');
      }

      // 2. Compute 10% allocation in microdollars ($0.000001 per unit)
      // netDynamicPoolCents * 10,000 = total microdollars
      // 10% sweep = (netDynamicPoolCents * 10,000 * 10) / 100 = netDynamicPoolCents * 1,000 microdollars
      const incomingSweepMicrousd = netDynamicPoolCents * 1000;
      const totalAccumulatedMicrousd = fund.fractionalResidualMicrousd + incomingSweepMicrousd;

      // Extract whole cents (10,000 microdollars per cent)
      const wholeCentsToSweep = Math.floor(totalAccumulatedMicrousd / 10000);
      const newResidualMicrousd = totalAccumulatedMicrousd % 10000;

      if (wholeCentsToSweep > 0) {
        const newCashBalance = fund.cashBalanceUsdCents + wholeCentsToSweep;
        const newAvailable = fund.availableUsdCents + wholeCentsToSweep;

        // Update fund balances
        await tx
          .update(rewardsFund)
          .set({
            cashBalanceUsdCents: newCashBalance,
            availableUsdCents: newAvailable,
            fractionalResidualMicrousd: newResidualMicrousd,
            version: sql`${rewardsFund.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(rewardsFund.id, fund.id));

        // Append to ledger
        await tx.insert(rewardsFundLedger).values({
          fundId: fund.id,
          type: 'sweep_in',
          amountCents: wholeCentsToSweep,
          fromBucket: 'external_settled_pool',
          toBucket: 'available',
          cashBalanceAfterCents: newCashBalance,
          availableAfterCents: newAvailable,
          allocatedAfterCents: fund.allocatedUsdCents,
          fundedPendingAfterCents: fund.fundedPendingUsdCents,
          sourceRef: sourceBatchRef,
          description: `10% auto-sweep from settled dynamic pool (${netDynamicPoolCents} cents pool)`,
          actorId: actorId ?? null,
        });

        this.logger.log(`Swept ${wholeCentsToSweep} cents into Rewards Fund from batch ${sourceBatchRef}`);
        return { sweptCents: wholeCentsToSweep, residualMicrousd: newResidualMicrousd };
      } else {
        // Only residual changed
        await tx
          .update(rewardsFund)
          .set({
            fractionalResidualMicrousd: newResidualMicrousd,
            version: sql`${rewardsFund.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(rewardsFund.id, fund.id));

        return { sweptCents: 0, residualMicrousd: newResidualMicrousd };
      }
    });
  }

  /**
   * Reconcile 5-Balance Solvency Invariant:
   * cash_balance_usd_cents == allocated_usd_cents + available_usd_cents + funded_pending_usd_cents
   */
  async checkSolvencyInvariant(currency = 'USD') {
    const fund = await this.getOrCreateFund(currency);
    const sumBuckets = fund.allocatedUsdCents + fund.availableUsdCents + fund.fundedPendingUsdCents;
    const isSolvent = fund.cashBalanceUsdCents === sumBuckets && fund.availableUsdCents >= 0;

    return {
      currency: fund.currency,
      cashBalanceUsdCents: fund.cashBalanceUsdCents,
      allocatedUsdCents: fund.allocatedUsdCents,
      availableUsdCents: fund.availableUsdCents,
      fundedPendingUsdCents: fund.fundedPendingUsdCents,
      spentUsdCents: fund.spentUsdCents,
      fractionalResidualMicrousd: fund.fractionalResidualMicrousd,
      sumBuckets,
      isSolvent,
      delta: fund.cashBalanceUsdCents - sumBuckets,
    };
  }

  /**
   * Super Admin Suspension Control: Global or per-user pause/resume
   */
  async setRewardsSuspension(
    scope: 'global' | 'user',
    action: 'pause' | 'resume',
    reason: string,
    performedBy: string,
    targetUserId?: string,
  ) {
    if (scope === 'user' && !targetUserId) {
      throw new BadRequestException('targetUserId is required for user-scoped suspension');
    }

    return await this.db.transaction(async (tx) => {
      if (scope === 'global') {
        const isPaused = action === 'pause';
        await tx
          .update(rewardsFundSettings)
          .set({ adsRewardsGlobalPaused: isPaused })
          .where(eq(rewardsFundSettings.isActive, true));
      } else if (scope === 'user' && targetUserId) {
        const isPaused = action === 'pause';
        await tx
          .update(schema.rewardsPointsBalances)
          .set({ isRewardsSuspended: isPaused })
          .where(eq(schema.rewardsPointsBalances.userId, targetUserId));
      }

      await tx.insert(adsRewardsSuspensionAudit).values({
        scope,
        targetUserId: targetUserId ?? null,
        action,
        reason,
        performedBy,
      });

      return { success: true, scope, action, targetUserId };
    });
  }
}
