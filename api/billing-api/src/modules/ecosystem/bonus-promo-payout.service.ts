import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export function bonusPromoPayoutBatchId(
  promoterId: string,
  impressionIds: readonly string[],
  carryInMicroUsd: bigint,
): string {
  const ordered = [...impressionIds].map(id => String(id).toLowerCase()).sort();
  const digest = createHash('sha256')
    .update(`bonus-promo-payout:v1:${promoterId.toLowerCase()}:${carryInMicroUsd.toString()}:${ordered.join(',')}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

/**
 * Authoritative Billing-owned payout writer for 55% promotional ad reserve earnings (PLAN-0155).
 * Preserves sub-cent microUSD residuals in bonus_promo_promoter_carries, revalidates supply/account
 * eligibility, uses source-derived receipt identities (never Date.now), and obeys program pause
 * without resetting 72-hour maturity or discarding accrued debt.
 */
@Injectable()
export class BonusPromoPayoutService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async clearDueBatch(assertLease?: () => Promise<void>, batchLimit = 50) {
    const swRes = rows(
      await this.db.execute(
        sql`SELECT enabled, is_locked_off FROM program_feature_switches WHERE key = 'bonus_ad_delivery' LIMIT 1`,
      ),
    );
    if (!swRes.length || swRes[0].is_locked_off || swRes[0].enabled !== true) {
      return { paused: true, clearedPromoters: 0, carriedPromoters: 0, paidCents: 0 };
    }

    const limit = Math.min(100, Math.max(1, Math.trunc(batchLimit)));

    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('bonus-promo-reserve', 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('platform-reserves-transfer', 0))`);
      if (assertLease) await assertLease();

      // Re-check switch inside transaction so a concurrent pause stops payout atomically
      const txSw = rows(
        await tx.execute(
          sql`SELECT enabled, is_locked_off FROM program_feature_switches WHERE key = 'bonus_ad_delivery' LIMIT 1`,
        ),
      );
      if (!txSw.length || txSw[0].is_locked_off || txSw[0].enabled !== true) {
        return { paused: true, clearedPromoters: 0, carriedPromoters: 0, paidCents: 0 };
      }

      // Mark confirmed-invalidated interactions as invalidated so they never accrue or block valid impressions
      await tx.execute(
        sql`UPDATE bonus_promo_impressions b
            SET clearance_status = 'invalidated'
            FROM ads_interactions e, ads_serves s
            WHERE b.clearance_status = 'pending'
              AND e.id = b.interaction_id
              AND s.id = b.serve_id
              AND (
                NOT e.is_valid
                OR e.assessment_status = 'invalidated'
                OR e.financial_eligibility = 'invalid'
                OR s.financial_eligibility = 'invalid'
                OR s.traffic_risk_status IN ('high_risk', 'confirmed_fraud')
              )`,
      );

      const dueGroups = rows(
        await tx.execute(
          sql`SELECT p.user_id,
                     b.promoter_id,
                     array_agg(b.id ORDER BY b.created_at ASC, b.id ASC) AS impression_ids,
                     sum(b.promoter_earnings_microusd)::text AS total_microusd
              FROM bonus_promo_impressions b
              JOIN ads_promoters p ON p.id = b.promoter_id
              JOIN users u ON u.id = p.user_id
              JOIN ads_promoter_websites w ON w.id = b.website_id
              JOIN ads_serves s ON s.id = b.serve_id
              JOIN ads_interactions e ON e.id = b.interaction_id
              WHERE b.clearance_status = 'pending'
                AND b.hold_expires_at <= now()
                AND p.is_active = true
                AND p.is_suspended = false
                AND u.status = 'ACTIVE'
                AND p.user_id <> b.advertiser_id
                AND w.verification_status = 'verified'
                AND w.policy_status = 'approved'
                AND w.is_active = true
                AND w.is_suspended = false
                AND e.is_valid = true
                AND e.assessment_status <> 'invalidated'
                AND e.financial_eligibility <> 'invalid'
                AND s.financial_eligibility <> 'invalid'
                AND s.traffic_risk_status NOT IN ('high_risk', 'confirmed_fraud')
              GROUP BY p.user_id, b.promoter_id
              ORDER BY b.promoter_id ASC
              LIMIT ${limit}`,
        ),
      );

      if (!dueGroups.length) {
        return { paused: false, clearedPromoters: 0, carriedPromoters: 0, paidCents: 0 };
      }

      const budget = rows(
        await tx.execute(
          sql`SELECT id, remaining_promo_budget_cents
              FROM advertiser_promo_budget
              ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        ),
      )[0];
      let budgetLeft = Number(budget?.remaining_promo_budget_cents ?? 0);
      let totalPaid = 0;
      let clearedPromoters = 0;
      let carriedPromoters = 0;

      for (const group of dueGroups) {
        if (assertLease) await assertLease();
        const promoterId = String(group.promoter_id);
        const userId = String(group.user_id);
        const impressionIds: string[] = Array.isArray(group.impression_ids)
          ? group.impression_ids.map(String)
          : [];
        if (!impressionIds.length) continue;

        const earnedMicroUsd = BigInt(String(group.total_microusd ?? '0'));
        if (earnedMicroUsd <= 0n) continue;

        await tx.execute(
          sql`INSERT INTO bonus_promo_promoter_carries (promoter_id, carry_microusd)
              VALUES (${promoterId}::uuid, 0)
              ON CONFLICT (promoter_id) DO NOTHING`,
        );
        const carryRow = rows(
          await tx.execute(
            sql`SELECT carry_microusd FROM bonus_promo_promoter_carries
                WHERE promoter_id = ${promoterId}::uuid FOR UPDATE`,
          ),
        )[0];
        const carryInMicroUsd = BigInt(String(carryRow?.carry_microusd ?? '0'));
        if (carryInMicroUsd < 0n || carryInMicroUsd >= 10_000n) {
          continue;
        }

        const combinedMicroUsd = carryInMicroUsd + earnedMicroUsd;
        const payableCents = Number(combinedMicroUsd / 10_000n);
        const carryOutMicroUsd = combinedMicroUsd % 10_000n;
        const batchId = bonusPromoPayoutBatchId(promoterId, impressionIds, carryInMicroUsd);

        if (payableCents === 0) {
          // Sub-cent maturity: retain exact microUSD in durable carry (backed by reserved_liability_cents)
          await tx.execute(
            sql`UPDATE bonus_promo_promoter_carries
                SET carry_microusd = ${carryOutMicroUsd.toString()}::bigint, updated_at = now()
                WHERE promoter_id = ${promoterId}::uuid`,
          );
          await tx.execute(
            sql`UPDATE bonus_promo_impressions
                SET clearance_status = 'cleared',
                    cleared_at = now(),
                    payout_batch_id = ${batchId}::uuid
                WHERE id = ANY(${impressionIds}::uuid[]) AND clearance_status = 'pending'`,
          );
          carriedPromoters++;
          continue;
        }

        if (payableCents > budgetLeft) {
          // Wait for reserve replenishment; preserve pending impressions & carry untouched
          continue;
        }

        const wallet = rows(
          await tx.execute(
            sql`SELECT id, balance_usd_cents FROM billing_wallets
                WHERE user_id = ${userId}::uuid FOR UPDATE`,
          ),
        )[0];
        if (!wallet) continue;

        const idempotencyKey = `bonus-promo-earning:v1:${batchId}`;
        const reference = `bonus-promo-v1-${batchId}`;
        const priorTx = rows(
          await tx.execute(
            sql`SELECT id, amount_usd_cents FROM billing_transactions
                WHERE idempotency_key = ${idempotencyKey} LIMIT 1`,
          ),
        )[0];

        let txId: string;
        if (priorTx) {
          txId = String(priorTx.id);
        } else {
          const beforeCents = Number(wallet.balance_usd_cents);
          const afterCents = beforeCents + payableCents;
          await tx.execute(
            sql`UPDATE billing_wallets
                SET balance_usd_cents = ${afterCents}, updated_at = now()
                WHERE id = ${wallet.id}::uuid`,
          );
          const metadata = JSON.stringify({
            version: 1,
            kind: 'bonus_promo_earning',
            payoutBatchId: batchId,
            promoterId,
            impressionCount: impressionIds.length,
            earnedMicroUsd: earnedMicroUsd.toString(),
            carryInMicroUsd: carryInMicroUsd.toString(),
            carryOutMicroUsd: carryOutMicroUsd.toString(),
          });
          const [insertedTx] = rows(
            await tx.execute(
              sql`INSERT INTO billing_transactions
                    (user_id, type, provider, status, amount_usd_cents, reference, idempotency_key, balance_before_usd_cents, balance_after_usd_cents, metadata)
                  VALUES
                    (${userId}::uuid, 'ads_earning', 'internal', 'completed', ${payableCents}, ${reference}, ${idempotencyKey}, ${beforeCents}, ${afterCents}, ${metadata}::jsonb)
                  RETURNING id`,
            ),
          );
          txId = String(insertedTx.id);
        }

        await tx.execute(
          sql`UPDATE bonus_promo_promoter_carries
              SET carry_microusd = ${carryOutMicroUsd.toString()}::bigint, updated_at = now()
              WHERE promoter_id = ${promoterId}::uuid`,
        );
        await tx.execute(
          sql`UPDATE bonus_promo_impressions
              SET clearance_status = 'cleared',
                  cleared_at = now(),
                  payout_batch_id = ${batchId}::uuid,
                  billing_transaction_id = ${txId}::uuid
              WHERE id IN (${sql.join(impressionIds.map((id) => sql`${id}::uuid`), sql`, `)})
                AND clearance_status = 'pending'`,
        );

        budgetLeft -= payableCents;
        totalPaid += payableCents;
        clearedPromoters++;
      }

      if (budget && (totalPaid > 0 || carriedPromoters > 0)) {
        const liabilityRes = rows(
          await tx.execute(
            sql`SELECT ceil((
                  coalesce((SELECT sum(promoter_earnings_microusd) FROM bonus_promo_impressions WHERE clearance_status = 'pending'), 0)::numeric
                  + coalesce((SELECT sum(carry_microusd) FROM bonus_promo_promoter_carries), 0)::numeric
                ) / 10000)::bigint AS reserved_cents`,
          ),
        );
        const reservedCents = Number(liabilityRes[0]?.reserved_cents ?? 0);
        await tx.execute(
          sql`UPDATE advertiser_promo_budget
              SET remaining_promo_budget_cents = remaining_promo_budget_cents - ${totalPaid},
                  paid_promoter_earnings_cents = paid_promoter_earnings_cents + ${totalPaid},
                  consumed_bonus_credits_cents = consumed_bonus_credits_cents + ${totalPaid},
                  reserved_liability_cents = ${reservedCents},
                  updated_at = now()
              WHERE id = ${budget.id}::uuid`,
        );
      }

      return { paused: false, clearedPromoters, carriedPromoters, paidCents: totalPaid };
    });
  }
}
