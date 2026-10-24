import { Injectable, Inject, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  rewardsFund,
  rewardsFundLedger,
  rewardsPointsBalances,
  rewardsPointsLedger,
  rewardsRedemptions,
  billingWallets,
  billingTransactions,
} from '@crimfig/database/schema';
import { eq, sql, and } from 'drizzle-orm';
import { WalletService } from '../wallet/wallet.service';

@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Redeem available points to cash wallet credit (billing_wallets).
   * 100 points = $1.00 USD (1 point = 1 cent).
   * Minimum redemption: 1,000 points ($10.00).
   * In a single atomic database transaction:
   * 1. Check user availablePoints >= pointsToRedeem and pointsToRedeem >= 1000.
   * 2. Lock Rewards Fund: move cash allocated_usd_cents -> spent_usd_cents.
   * 3. Debit user availablePoints in rewards_points_balances.
   * 4. Credit destination billing_wallets balance_usd_cents.
   * 5. Append immutable rows in rewards_fund_ledger, rewards_points_ledger, and rewards_redemptions.
   */
  async redeemToWallet(userId: string, pointsToRedeem: number, idempotencyKey: string) {
    if (pointsToRedeem < 1000) {
      throw new BadRequestException('Minimum redemption threshold is 1,000 points ($10.00 USD)');
    }

    if (pointsToRedeem % 100 !== 0) {
      throw new BadRequestException('Redemptions must be in whole 100-point increments ($1.00)');
    }

    const cashCreditCents = pointsToRedeem; // 1 point = 1 cent

    // Check existing redemption with idempotency key
    const [existingRedemption] = await this.db
      .select()
      .from(rewardsRedemptions)
      .where(eq(rewardsRedemptions.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existingRedemption) {
      return { status: 'already_processed', redemption: existingRedemption };
    }

    return await this.db.transaction(async (tx) => {
      // 1. Lock user point balance
      const [userBalance] = await tx
        .select()
        .from(rewardsPointsBalances)
        .where(eq(rewardsPointsBalances.userId, userId))
        .for('update');

      if (!userBalance || userBalance.availablePoints < pointsToRedeem) {
        throw new BadRequestException(
          `Insufficient available points balance. Have ${userBalance?.availablePoints ?? 0}, requested ${pointsToRedeem}`,
        );
      }

      if (userBalance.isRewardsSuspended) {
        throw new BadRequestException('Account rewards activity is suspended. Cannot redeem points.');
      }

      // 2. Lock Rewards Fund
      const [fund] = await tx
        .select()
        .from(rewardsFund)
        .where(eq(rewardsFund.currency, 'USD'))
        .for('update');

      if (fund.allocatedUsdCents < cashCreditCents) {
        throw new ConflictException('Solvency anomaly: Fund allocated cash is less than redemption amount');
      }

      const newAllocated = fund.allocatedUsdCents - cashCreditCents;
      const newSpent = fund.spentUsdCents + cashCreditCents;
      const newCashBalance = fund.cashBalanceUsdCents - cashCreditCents;

      // Update Rewards Fund
      await tx
        .update(rewardsFund)
        .set({
          allocatedUsdCents: newAllocated,
          spentUsdCents: newSpent,
          cashBalanceUsdCents: newCashBalance,
          version: sql`${rewardsFund.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(rewardsFund.id, fund.id));

      // Append to rewards_fund_ledger
      await tx.insert(rewardsFundLedger).values({
        fundId: fund.id,
        type: 'spend',
        amountCents: cashCreditCents,
        fromBucket: 'allocated',
        toBucket: 'spent',
        cashBalanceAfterCents: newCashBalance,
        availableAfterCents: fund.availableUsdCents,
        allocatedAfterCents: newAllocated,
        fundedPendingAfterCents: fund.fundedPendingUsdCents,
        sourceRef: `redemption:${idempotencyKey}`,
        description: `Point redemption to user wallet: ${pointsToRedeem} pts ($${(cashCreditCents / 100).toFixed(2)})`,
        actorId: userId,
      });

      // 3. Debit user available points
      await tx
        .update(rewardsPointsBalances)
        .set({
          availablePoints: sql`${rewardsPointsBalances.availablePoints} - ${pointsToRedeem}`,
          lifetimeRedeemedPoints: sql`${rewardsPointsBalances.lifetimeRedeemedPoints} + ${pointsToRedeem}`,
          version: sql`${rewardsPointsBalances.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(rewardsPointsBalances.userId, userId));

      // Append to rewards_points_ledger
      await tx.insert(rewardsPointsLedger).values({
        lotId: `redemption-${Date.now()}`,
        userId,
        deltaPoints: -pointsToRedeem,
        state: 'redeemed',
        activityCode: 'point_redemption_wallet',
        sourceRef: idempotencyKey,
        idempotencyKey,
        valuationMicrousd: cashCreditCents * 10000,
        rateVersion: 1,
      });

      // 4. Ensure wallet exists and credit cash balance
      const [wallet] = await tx
        .select()
        .from(billingWallets)
        .where(eq(billingWallets.userId, userId))
        .for('update');

      let walletId: string;
      if (wallet) {
        walletId = wallet.id;
        await tx
          .update(billingWallets)
          .set({
            balanceUsdCents: sql`${billingWallets.balanceUsdCents} + ${cashCreditCents}`,
            version: sql`${billingWallets.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(billingWallets.id, wallet.id));
      } else {
        const [newWallet] = await tx
          .insert(billingWallets)
          .values({
            userId,
            balanceUsdCents: cashCreditCents,
            lockedUsdCents: 0,
          })
          .returning();
        walletId = newWallet.id;
      }

      // 5. Append to rewards_redemptions
      const [redemption] = await tx
        .insert(rewardsRedemptions)
        .values({
          userId,
          type: 'wallet_credit',
          status: 'completed',
          pointsRedeemed: pointsToRedeem,
          usdCentsAmount: cashCreditCents,
          destinationRef: walletId,
          idempotencyKey,
          completedAt: new Date(),
        })
        .returning();

      return {
        status: 'completed',
        pointsRedeemed: pointsToRedeem,
        creditedUsdCents: cashCreditCents,
        destinationWalletId: walletId,
        redemptionId: redemption.id,
      };
    });
  }
}
