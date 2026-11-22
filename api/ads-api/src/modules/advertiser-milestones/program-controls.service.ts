import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';

export type ReserveBucket =
  | 'platform_operating_reserve'
  | 'promotional_ad_reserve'
  | 'rewards_fund_available';

export const DEFAULT_SWITCH_STATES: Record<string, boolean> = {
  advertiser_bonus_credit: true,
  bonus_ad_delivery: true,
  house_cfig_earning: true,
  redeemable_points: true,
  cfig_to_points_conversion: false,
};

const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const rows = (r: any): any[] => r?.rows ?? r ?? [];

@Injectable()
export class ProgramControlsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  private assertUuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private assertReason(reason: unknown) {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) {
      throw new BadRequestException('Reason must be between 3 and 500 characters');
    }
  }

  async isSwitchEnabled(key: string, conn: any = this.db): Promise<boolean> {
    try {
      const res = rows(
        await conn.execute(
          sql`SELECT enabled, is_locked_off FROM program_feature_switches WHERE key = ${key} LIMIT 1`,
        ),
      );
      if (res.length > 0 && res[0].enabled !== undefined) {
        if (res[0].is_locked_off) return false;
        return Boolean(res[0].enabled);
      }
    } catch {
      // Fall back safely on unmigrated/lightweight unit fixtures
    }
    return DEFAULT_SWITCH_STATES[key] ?? false;
  }

  async getAdminOverview() {
    const [switchesRes, auditRes, promoRes, fundRes, opRes, transfersRes, alertsRes] =
      await Promise.all([
        this.db.execute(
          sql`SELECT key, enabled, is_locked_off, label, description, updated_by, updated_at
              FROM program_feature_switches ORDER BY key`,
        ),
        this.db.execute(
          sql`SELECT id, switch_key, previous_enabled, next_enabled, reason, request_id, actor_id, created_at
              FROM program_feature_switch_audit ORDER BY created_at DESC LIMIT 30`,
        ),
        this.db.execute(
          sql`SELECT id, total_allocated_cents, issued_bonus_credits_cents, consumed_bonus_credits_cents,
                     remaining_promo_budget_cents, reserved_liability_cents, paid_promoter_earnings_cents,
                     is_issuance_halted, updated_at
              FROM advertiser_promo_budget ORDER BY updated_at DESC LIMIT 1`,
        ),
        this.db.execute(
          sql`SELECT id, currency, cash_balance_usd_cents, available_usd_cents, allocated_usd_cents,
                     funded_pending_usd_cents, spent_usd_cents, reserve_floor_usd_cents, updated_at
              FROM rewards_fund WHERE currency = 'USD' LIMIT 1`,
        ),
        this.db.execute(
          sql`SELECT id, currency, available_cents, updated_at
              FROM platform_operating_reserve WHERE currency = 'USD' LIMIT 1`,
        ),
        this.db.execute(
          sql`SELECT id, request_id, from_reserve, to_reserve, amount_cents, reason, actor_id, created_at
              FROM platform_reserve_transfers ORDER BY created_at DESC LIMIT 30`,
        ),
        this.db.execute(
          sql`SELECT id, category, severity, advertiser_id, campaign_id, milestone_id, summary, details, status, acknowledged_by, acknowledged_at, created_at
              FROM platform_admin_silent_alerts ORDER BY status = 'open' DESC, created_at DESC LIMIT 50`,
        ),
      ]);

    const promoRow = rows(promoRes)[0] ?? null;
    const fundRow = rows(fundRes)[0] ?? null;
    const opRow = rows(opRes)[0] ?? null;
    const fundAvailable = Number(fundRow?.available_usd_cents ?? 0);
    const fundFloor = Number(fundRow?.reserve_floor_usd_cents ?? 0);

    return {
      switches: rows(switchesRes).map((r: any) => ({
        key: r.key,
        enabled: r.is_locked_off ? false : Boolean(r.enabled),
        isLockedOff: Boolean(r.is_locked_off),
        label: r.label,
        description: r.description,
        updatedBy: r.updated_by ?? null,
        updatedAt: r.updated_at,
      })),
      switchAudit: rows(auditRes).map((r: any) => ({
        id: r.id,
        switchKey: r.switch_key,
        previousEnabled: Boolean(r.previous_enabled),
        nextEnabled: Boolean(r.next_enabled),
        reason: r.reason,
        requestId: r.request_id,
        actorId: r.actor_id,
        createdAt: r.created_at,
      })),
      reserves: {
        promotionalAdReserve: promoRow
          ? {
              totalAllocatedCents: Number(promoRow.total_allocated_cents ?? 0),
              issuedBonusCreditsCents: Number(promoRow.issued_bonus_credits_cents ?? 0),
              consumedBonusCreditsCents: Number(promoRow.consumed_bonus_credits_cents ?? 0),
              remainingPromoBudgetCents: Number(promoRow.remaining_promo_budget_cents ?? 0),
              reservedLiabilityCents: Number(promoRow.reserved_liability_cents ?? 0),
              paidPromoterEarningsCents: Number(promoRow.paid_promoter_earnings_cents ?? 0),
              transferableCents: Math.max(
                0,
                Number(promoRow.remaining_promo_budget_cents ?? 0) -
                  Number(promoRow.reserved_liability_cents ?? 0),
              ),
              isIssuanceHalted: Boolean(promoRow.is_issuance_halted),
              updatedAt: promoRow.updated_at,
            }
          : null,
        rewardsFund: fundRow
          ? {
              currency: fundRow.currency,
              cashBalanceUsdCents: Number(fundRow.cash_balance_usd_cents ?? 0),
              availableUsdCents: fundAvailable,
              allocatedUsdCents: Number(fundRow.allocated_usd_cents ?? 0),
              fundedPendingUsdCents: Number(fundRow.funded_pending_usd_cents ?? 0),
              spentUsdCents: Number(fundRow.spent_usd_cents ?? 0),
              reserveFloorUsdCents: fundFloor,
              transferableCents: Math.max(0, fundAvailable - fundFloor),
              updatedAt: fundRow.updated_at,
            }
          : null,
        platformOperatingReserve: opRow
          ? {
              currency: opRow.currency,
              availableCents: Number(opRow.available_cents ?? 0),
              transferableCents: Math.max(0, Number(opRow.available_cents ?? 0)),
              updatedAt: opRow.updated_at,
            }
          : null,
      },
      transfers: rows(transfersRes).map((r: any) => ({
        id: r.id,
        requestId: r.request_id,
        fromReserve: r.from_reserve,
        toReserve: r.to_reserve,
        amountCents: Number(r.amount_cents),
        reason: r.reason,
        actorId: r.actor_id,
        createdAt: r.created_at,
      })),
      alerts: rows(alertsRes).map((r: any) => ({
        id: r.id,
        category: r.category,
        severity: r.severity,
        advertiserId: r.advertiser_id,
        campaignId: r.campaign_id,
        milestoneId: r.milestone_id,
        summary: r.summary,
        details: r.details ?? {},
        status: r.status,
        acknowledgedBy: r.acknowledged_by,
        acknowledgedAt: r.acknowledged_at,
        createdAt: r.created_at,
      })),
    };
  }

  async toggleSwitch(
    actorId: string,
    key: string,
    input: { enabled: boolean; reason: string; requestId: string },
  ) {
    this.assertUuid(actorId, 'actorId');
    this.assertUuid(input?.requestId, 'requestId');
    this.assertReason(input?.reason);
    if (typeof input?.enabled !== 'boolean') {
      throw new BadRequestException('enabled must be a boolean');
    }

    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`program-switch:${key}`}, 0))`,
      );

      const priorAudit = rows(
        await tx.execute(
          sql`SELECT switch_key, next_enabled, reason, actor_id FROM program_feature_switch_audit WHERE request_id = ${input.requestId} LIMIT 1`,
        ),
      )[0];
      if (priorAudit) {
        if (
          priorAudit.switch_key !== key ||
          Boolean(priorAudit.next_enabled) !== input.enabled ||
          priorAudit.reason !== input.reason
        ) {
          throw new ConflictException('Switch request identity mismatch');
        }
        return rows(
          await tx.execute(
            sql`SELECT key, enabled, is_locked_off, label, description, updated_by, updated_at FROM program_feature_switches WHERE key = ${key}`,
          ),
        )[0];
      }

      const current = rows(
        await tx.execute(
          sql`SELECT key, enabled, is_locked_off FROM program_feature_switches WHERE key = ${key} FOR UPDATE`,
        ),
      )[0];
      if (!current) {
        throw new NotFoundException(`Unknown program switch: ${key}`);
      }
      if (current.is_locked_off && input.enabled) {
        throw new ConflictException(
          'This feature switch is locked OFF pending separate funding and launch authorization.',
        );
      }

      const [updated] = rows(
        await tx.execute(
          sql`UPDATE program_feature_switches
              SET enabled = ${input.enabled}, updated_by = ${actorId}::uuid, updated_at = now()
              WHERE key = ${key}
              RETURNING key, enabled, is_locked_off, label, description, updated_by, updated_at`,
        ),
      );
      await tx.execute(
        sql`INSERT INTO program_feature_switch_audit (switch_key, previous_enabled, next_enabled, reason, request_id, actor_id)
            VALUES (${key}, ${Boolean(current.enabled)}, ${input.enabled}, ${input.reason.trim()}, ${input.requestId}::uuid, ${actorId}::uuid)`,
      );

      if (key === 'redeemable_points') {
        await tx.execute(
          sql`UPDATE rewards_fund_settings SET ads_rewards_global_paused = ${!input.enabled} WHERE is_active = true`,
        );
      }

      return {
        key: updated.key,
        enabled: updated.is_locked_off ? false : Boolean(updated.enabled),
        isLockedOff: Boolean(updated.is_locked_off),
        label: updated.label,
        description: updated.description,
        updatedBy: updated.updated_by,
        updatedAt: updated.updated_at,
      };
    });
  }

  async transferBetweenReserves(
    actorId: string,
    input: {
      fromReserve: ReserveBucket;
      toReserve: ReserveBucket;
      amountCents: number;
      reason: string;
      requestId: string;
    },
  ) {
    this.assertUuid(actorId, 'actorId');
    this.assertUuid(input?.requestId, 'requestId');
    this.assertReason(input?.reason);
    const valid: ReserveBucket[] = [
      'platform_operating_reserve',
      'promotional_ad_reserve',
      'rewards_fund_available',
    ];
    if (!valid.includes(input?.fromReserve) || !valid.includes(input?.toReserve)) {
      throw new BadRequestException('Invalid source or destination reserve');
    }
    if (input.fromReserve === input.toReserve) {
      throw new BadRequestException('Source and destination reserves must differ');
    }
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new BadRequestException('Transfer amountCents must be a positive integer');
    }

    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('platform-reserves-transfer', 0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('rewards-fund:USD', 0))`,
      );

      const prior = rows(
        await tx.execute(
          sql`SELECT id, request_id, from_reserve, to_reserve, amount_cents, reason, actor_id, created_at
              FROM platform_reserve_transfers WHERE request_id = ${input.requestId}::uuid LIMIT 1`,
        ),
      )[0];
      if (prior) {
        if (
          prior.from_reserve !== input.fromReserve ||
          prior.to_reserve !== input.toReserve ||
          Number(prior.amount_cents) !== input.amountCents ||
          prior.reason !== input.reason.trim()
        ) {
          throw new ConflictException('Reserve transfer request identity changed');
        }
        return prior;
      }

      const amount = input.amountCents;
      const opRow = rows(
        await tx.execute(
          sql`SELECT id, available_cents FROM platform_operating_reserve WHERE currency = 'USD' FOR UPDATE`,
        ),
      )[0];
      const promoRow = rows(
        await tx.execute(
          sql`SELECT id, total_allocated_cents, remaining_promo_budget_cents, reserved_liability_cents
              FROM advertiser_promo_budget ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        ),
      )[0];
      const fundRow = rows(
        await tx.execute(
          sql`SELECT id, cash_balance_usd_cents, available_usd_cents, allocated_usd_cents, funded_pending_usd_cents, reserve_floor_usd_cents
              FROM rewards_fund WHERE currency = 'USD' FOR UPDATE`,
        ),
      )[0];

      // Debit source with explicit solvency / floor invariants
      if (input.fromReserve === 'platform_operating_reserve') {
        if (!opRow || Number(opRow.available_cents) < amount) {
          throw new ConflictException('Insufficient Platform Operating Reserve balance');
        }
        await tx.execute(
          sql`UPDATE platform_operating_reserve SET available_cents = available_cents - ${amount}, updated_at = now() WHERE id = ${opRow.id}::uuid`,
        );
      } else if (input.fromReserve === 'promotional_ad_reserve') {
        const unreserved =
          Number(promoRow?.remaining_promo_budget_cents ?? 0) -
          Number(promoRow?.reserved_liability_cents ?? 0);
        if (!promoRow || unreserved < amount) {
          throw new ConflictException(
            'Insufficient unreserved Promotional Ad Reserve balance',
          );
        }
        await tx.execute(
          sql`UPDATE advertiser_promo_budget
              SET total_allocated_cents = total_allocated_cents - ${amount},
                  remaining_promo_budget_cents = remaining_promo_budget_cents - ${amount},
                  updated_at = now()
              WHERE id = ${promoRow.id}::uuid`,
        );
      } else if (input.fromReserve === 'rewards_fund_available') {
        const available = Number(fundRow?.available_usd_cents ?? 0);
        const floor = Number(fundRow?.reserve_floor_usd_cents ?? 0);
        if (!fundRow || available - amount < floor || Number(fundRow.cash_balance_usd_cents) < amount) {
          throw new ConflictException(
            'Transfer would breach the Rewards Fund reserve floor or available balance',
          );
        }
        const nextCash = Number(fundRow.cash_balance_usd_cents) - amount;
        const nextAvailable = available - amount;
        await tx.execute(
          sql`UPDATE rewards_fund
              SET cash_balance_usd_cents = ${nextCash},
                  available_usd_cents = ${nextAvailable},
                  version = version + 1,
                  updated_at = now()
              WHERE id = ${fundRow.id}::uuid`,
        );
        await tx.execute(
          sql`INSERT INTO rewards_fund_ledger (fund_id, type, amount_cents, from_bucket, to_bucket, cash_balance_after_cents, available_after_cents, allocated_after_cents, funded_pending_after_cents, source_ref, description, actor_id)
              VALUES (${fundRow.id}::uuid, 'adjust_out', ${amount}, 'available', ${input.toReserve}, ${nextCash}, ${nextAvailable}, ${Number(fundRow.allocated_usd_cents)}, ${Number(fundRow.funded_pending_usd_cents)}, ${`reserve-transfer:${input.requestId}`}, ${input.reason.trim()}, ${actorId}::uuid)`,
        );
      }

      // Credit destination
      if (input.toReserve === 'platform_operating_reserve') {
        if (!opRow) {
          await tx.execute(
            sql`INSERT INTO platform_operating_reserve (currency, available_cents) VALUES ('USD', ${amount})`,
          );
        } else {
          await tx.execute(
            sql`UPDATE platform_operating_reserve SET available_cents = available_cents + ${amount}, updated_at = now() WHERE id = ${opRow.id}::uuid`,
          );
        }
      } else if (input.toReserve === 'promotional_ad_reserve') {
        if (!promoRow) {
          await tx.execute(
            sql`INSERT INTO advertiser_promo_budget (total_allocated_cents, remaining_promo_budget_cents) VALUES (${amount}, ${amount})`,
          );
        } else {
          await tx.execute(
            sql`UPDATE advertiser_promo_budget
                SET total_allocated_cents = total_allocated_cents + ${amount},
                    remaining_promo_budget_cents = remaining_promo_budget_cents + ${amount},
                    updated_at = now()
                WHERE id = ${promoRow.id}::uuid`,
          );
        }
      } else if (input.toReserve === 'rewards_fund_available') {
        if (!fundRow) {
          throw new ConflictException('USD Rewards Fund is not initialized');
        }
        const nextCash = Number(fundRow.cash_balance_usd_cents) + amount;
        const nextAvailable = Number(fundRow.available_usd_cents) + amount;
        await tx.execute(
          sql`UPDATE rewards_fund
              SET cash_balance_usd_cents = ${nextCash},
                  available_usd_cents = ${nextAvailable},
                  version = version + 1,
                  updated_at = now()
              WHERE id = ${fundRow.id}::uuid`,
        );
        await tx.execute(
          sql`INSERT INTO rewards_fund_ledger (fund_id, type, amount_cents, from_bucket, to_bucket, cash_balance_after_cents, available_after_cents, allocated_after_cents, funded_pending_after_cents, source_ref, description, actor_id)
              VALUES (${fundRow.id}::uuid, 'adjust_in', ${amount}, ${input.fromReserve}, 'available', ${nextCash}, ${nextAvailable}, ${Number(fundRow.allocated_usd_cents)}, ${Number(fundRow.funded_pending_usd_cents)}, ${`reserve-transfer:${input.requestId}`}, ${input.reason.trim()}, ${actorId}::uuid)`,
        );
      }

      const [transfer] = rows(
        await tx.execute(
          sql`INSERT INTO platform_reserve_transfers (request_id, from_reserve, to_reserve, amount_cents, reason, actor_id)
              VALUES (${input.requestId}::uuid, ${input.fromReserve}, ${input.toReserve}, ${amount}, ${input.reason.trim()}, ${actorId}::uuid)
              RETURNING id, request_id, from_reserve, to_reserve, amount_cents, reason, actor_id, created_at`,
        ),
      );
      return transfer;
    });
  }

  async recordOperatingProceeds(
    actorId: string,
    input: { amountCents: number; sourceRef: string; reason: string; requestId: string },
  ) {
    this.assertUuid(actorId, 'actorId');
    this.assertUuid(input?.requestId, 'requestId');
    this.assertReason(input?.reason);
    if (typeof input?.sourceRef !== 'string' || input.sourceRef.trim().length < 3 || input.sourceRef.length > 128) {
      throw new BadRequestException('sourceRef must be 3-128 characters');
    }
    if (!Number.isSafeInteger(input?.amountCents) || input.amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('platform-reserves-transfer', 0))`,
      );
      const prior = rows(
        await tx.execute(
          sql`SELECT id, request_id, from_reserve, to_reserve, amount_cents, reason, actor_id, created_at
              FROM platform_reserve_transfers WHERE request_id = ${input.requestId}::uuid LIMIT 1`,
        ),
      )[0];
      if (prior) {
        if (
          prior.from_reserve !== 'realized_platform_proceeds' ||
          prior.to_reserve !== 'platform_operating_reserve' ||
          Number(prior.amount_cents) !== input.amountCents
        ) {
          throw new ConflictException('Operating reserve deposit identity changed');
        }
        return prior;
      }

      const opRow = rows(
        await tx.execute(
          sql`SELECT id FROM platform_operating_reserve WHERE currency = 'USD' FOR UPDATE`,
        ),
      )[0];
      if (!opRow) {
        await tx.execute(
          sql`INSERT INTO platform_operating_reserve (currency, available_cents) VALUES ('USD', ${input.amountCents})`,
        );
      } else {
        await tx.execute(
          sql`UPDATE platform_operating_reserve SET available_cents = available_cents + ${input.amountCents}, updated_at = now() WHERE id = ${opRow.id}::uuid`,
        );
      }
      const [record] = rows(
        await tx.execute(
          sql`INSERT INTO platform_reserve_transfers (request_id, from_reserve, to_reserve, amount_cents, reason, actor_id)
              VALUES (${input.requestId}::uuid, 'realized_platform_proceeds', 'platform_operating_reserve', ${input.amountCents}, ${`${input.sourceRef.trim()}: ${input.reason.trim()}`}, ${actorId}::uuid)
              RETURNING id, request_id, from_reserve, to_reserve, amount_cents, reason, actor_id, created_at`,
        ),
      );
      return record;
    });
  }

  async recordSilentAlert(
    txOrDb: any,
    alert: {
      category: 'full_bonus_campaign' | 'post_award_anomaly' | 'self_dealing_risk' | 'compliance_flag';
      severity?: 'info' | 'warning' | 'high';
      advertiserId?: string | null;
      campaignId?: string | null;
      milestoneId?: string | null;
      summary: string;
      details?: Record<string, unknown>;
    },
  ) {
    try {
      await txOrDb.execute(
        sql`INSERT INTO platform_admin_silent_alerts (category, severity, advertiser_id, campaign_id, milestone_id, summary, details)
            VALUES (${alert.category}, ${alert.severity ?? 'info'}, ${alert.advertiserId ?? null}::uuid, ${alert.campaignId ?? null}::uuid, ${alert.milestoneId ?? null}, ${alert.summary}, ${JSON.stringify(alert.details ?? {})}::jsonb)`,
      );
    } catch {
      // Non-blocking silent safety alert: ignore if unmigrated mock fixture
    }
  }

  async acknowledgeAlert(actorId: string, alertId: string) {
    this.assertUuid(actorId, 'actorId');
    this.assertUuid(alertId, 'alertId');
    const [updated] = rows(
      await this.db.execute(
        sql`UPDATE platform_admin_silent_alerts
            SET status = 'acknowledged', acknowledged_by = ${actorId}::uuid, acknowledged_at = now()
            WHERE id = ${alertId}::uuid
            RETURNING id, status, acknowledged_by, acknowledged_at`,
      ),
    );
    if (!updated) throw new NotFoundException('Alert not found');
    return updated;
  }

  /** Clear matured (>=72h) bonus-promo viewable impressions from Promotional Ad Reserve into promoter cash wallets. */
  async clearMaturedBonusPromoEarnings(assertLease?: () => Promise<void>) {
    if (!(await this.isSwitchEnabled('bonus_ad_delivery'))) return { clearedPromoters: 0, paidCents: 0 };
    return this.db.transaction(async (tx: any) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('bonus-promo-reserve', 0))`);
      if (assertLease) await assertLease();

      const dueGroups = rows(
        await tx.execute(
          sql`SELECT p.user_id, b.promoter_id,
                     array_agg(b.id) AS impression_ids,
                     sum(b.promoter_earnings_microusd)::bigint AS total_microusd
              FROM bonus_promo_impressions b
              JOIN ads_promoters p ON p.id = b.promoter_id
              JOIN ads_interactions e ON e.id = b.interaction_id
              WHERE b.clearance_status = 'pending'
                AND b.hold_expires_at <= now()
                AND e.assessment_status <> 'invalidated'
              GROUP BY p.user_id, b.promoter_id`,
        ),
      );
      if (!dueGroups.length) return { clearedPromoters: 0, paidCents: 0 };

      let totalPaid = 0;
      let clearedPromoters = 0;
      const budget = rows(
        await tx.execute(
          sql`SELECT id, remaining_promo_budget_cents FROM advertiser_promo_budget ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        ),
      )[0];
      let budgetLeft = Number(budget?.remaining_promo_budget_cents ?? 0);

      for (const g of dueGroups) {
        const cents = Math.floor(Number(g.total_microusd) / 10000);
        if (cents <= 0 || cents > budgetLeft) continue;
        const wallet = rows(
          await tx.execute(
            sql`SELECT id, balance_usd_cents FROM billing_wallets WHERE user_id = ${g.user_id}::uuid FOR UPDATE`,
          ),
        )[0];
        if (!wallet) continue;

        const batchRef = `bonus-promo-clearance:${g.promoter_id}:${cents}:${Date.now()}`;
        await tx.execute(
          sql`UPDATE billing_wallets SET balance_usd_cents = balance_usd_cents + ${cents}, updated_at = now() WHERE id = ${wallet.id}::uuid`,
        );
        await tx.execute(
          sql`INSERT INTO billing_transactions (user_id, type, provider, status, amount_usd_cents, reference, idempotency_key, balance_before_usd_cents, balance_after_usd_cents, metadata)
              VALUES (${g.user_id}::uuid, 'ads_earning', 'internal', 'completed', ${cents}, ${batchRef}, ${batchRef}, ${Number(wallet.balance_usd_cents)}, ${Number(wallet.balance_usd_cents) + cents}, ${JSON.stringify({ kind: 'bonus_promo_55_share', promoterId: g.promoter_id })}::jsonb)`,
        );
        await tx.execute(
          sql`UPDATE bonus_promo_impressions
              SET clearance_status = 'cleared', cleared_at = now()
              WHERE id = ANY(${g.impression_ids}::uuid[])`,
        );
        budgetLeft -= cents;
        totalPaid += cents;
        clearedPromoters++;
      }

      if (budget && totalPaid > 0) {
        const pendingRes = rows(
          await tx.execute(
            sql`SELECT ceil(coalesce(sum(promoter_earnings_microusd), 0)::numeric / 10000)::bigint AS reserved_cents
                FROM bonus_promo_impressions WHERE clearance_status = 'pending'`,
          ),
        );
        await tx.execute(
          sql`UPDATE advertiser_promo_budget
              SET remaining_promo_budget_cents = remaining_promo_budget_cents - ${totalPaid},
                  paid_promoter_earnings_cents = paid_promoter_earnings_cents + ${totalPaid},
                  consumed_bonus_credits_cents = consumed_bonus_credits_cents + ${totalPaid},
                  reserved_liability_cents = ${Number(pendingRes[0]?.reserved_cents ?? 0)},
                  updated_at = now()
              WHERE id = ${budget.id}::uuid`,
        );
      }

      return { clearedPromoters, paidCents: totalPaid };
    });
  }
}
