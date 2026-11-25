import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { readMilestoneEvidence } from './milestone-evidence';
import {
  BONUS_CREDIT_LIFETIME_MAX_CENTS,
  milestoneDefinitions,
  recognitionDecisions,
  recognitionPolicyVersion,
} from './milestone-policy';
import { ProgramControlsService } from './program-controls.service';

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const rows = (r: any): any[] => r?.rows ?? r ?? [];

export function deterministicBonusLedgerUuid(
  kind: 'reserve' | 'consume' | 'release',
  scopeId: string,
  creditId: string,
  ordinal = '0',
): string {
  const digest = createHash('sha256')
    .update(`plan0155:bonus-${kind}:${scopeId.toLowerCase()}:${creditId.toLowerCase()}:${ordinal}`)
    .digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '4' + digest.slice(13, 16),
    '8' + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

@Injectable()
export class AdvertiserMilestonesService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    @Optional() private readonly controls?: ProgramControlsService,
  ) {}

  private validateIdentity(advertiserId: string) {
    if (typeof advertiserId !== 'string' || !UUID_RE.test(advertiserId)) {
      throw new UnauthorizedException('Authenticated advertiser required');
    }
  }

  /** Explicit persisted activation required (PLAN-0155 G07). */
  private async safeSwitchEnabled(key: string, conn: any): Promise<boolean> {
    if (this.controls) return this.controls.isSwitchEnabled(key, conn);
    try {
      const res = rows(
        await conn.execute(
          sql`SELECT enabled, is_locked_off FROM program_feature_switches WHERE key = ${key} LIMIT 1`,
        ),
      );
      if (res.length > 0 && res[0].enabled !== undefined) {
        return !res[0].is_locked_off && res[0].enabled === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async getAdvertiserAchievements(advertiserId: string) {
    this.validateIdentity(advertiserId);
    return this.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const evidence = await readMilestoneEvidence(tx, advertiserId);
      const achievements = await tx.select({
        id: schema.advertiserAchievements.id,
        tier: schema.advertiserAchievements.tier,
        badgeTitle: schema.advertiserAchievements.badgeTitle,
        bonusCreditCents: schema.advertiserAchievements.bonusCreditCents,
        bonusCreditRemainingCents: schema.advertiserAchievements.bonusCreditRemainingCents,
        creditExpiresAt: schema.advertiserAchievements.creditExpiresAt,
        isClawedBack: schema.advertiserAchievements.isClawedBack,
        achievedAt: schema.advertiserAchievements.achievedAt,
      }).from(schema.advertiserAchievements)
        .where(eq(schema.advertiserAchievements.advertiserId, advertiserId))
        .orderBy(desc(schema.advertiserAchievements.achievedAt));

      const awards = await tx.execute<{ id: string; milestone_id: string; state: string; first_qualified_at: Date }>(sql`
        SELECT id,milestone_id,state,first_qualified_at FROM advertiser_recognition_awards
        WHERE advertiser_id=${advertiserId}::uuid AND qualifying_scope='lifetime' ORDER BY first_qualified_at,id`);

      let bonusClaims: any[] = [];
      let promoRemainingCents = 0;
      try {
        bonusClaims = rows(
          await tx.execute(
            sql`SELECT id, milestone_id, request_id, policy_version, qualifying_spend_cents, credit_cents,
                       remaining_credit_cents, reserved_credit_cents, consumed_credit_cents, state, claimed_at
                FROM advertiser_bonus_credits
                WHERE advertiser_id = ${advertiserId}::uuid
                ORDER BY claimed_at ASC`,
          ),
        );
        const promoRes = rows(
          await tx.execute(
            sql`SELECT remaining_promo_budget_cents FROM advertiser_promo_budget ORDER BY updated_at DESC LIMIT 1`,
          ),
        );
        promoRemainingCents = Number(promoRes[0]?.remaining_promo_budget_cents ?? 0);
      } catch {
        bonusClaims = [];
      }

      const bonusSwitchOn = await this.safeSwitchEnabled('advertiser_bonus_credit', tx);
      const deliverySwitchOn = await this.safeSwitchEnabled('bonus_ad_delivery', tx);

      const decisions = recognitionDecisions(evidence);
      const eligible = evidence.campaigns.filter(campaign => campaign.eligible);
      const pending = evidence.campaigns.filter(
        campaign =>
          (campaign.qualifying ?? campaign.completed) &&
          !campaign.eligible &&
          !campaign.preCutoffOnly,
      ).length;
      const spend = eligible.reduce((total, campaign) => total + campaign.clearedSpendCents!, 0);

      const claimedByTier = new Map(bonusClaims.map((c: any) => [c.milestone_id, c]));
      const legacyMonetaryTiers = new Set<string>(
        achievements
          .filter(a => Number(a.bonusCreditCents ?? 0) > 0 && !a.isClawedBack)
          .map(a => String(a.tier)),
      );
      const availableBonusCents = bonusClaims.reduce((s: number, c: any) => s + Number(c.remaining_credit_cents ?? 0), 0);
      const reservedBonusCents = bonusClaims.reduce((s: number, c: any) => s + Number(c.reserved_credit_cents ?? 0), 0);
      const consumedBonusCents = bonusClaims.reduce((s: number, c: any) => s + Number(c.consumed_credit_cents ?? 0), 0);
      const lifetimeClaimedCents = bonusClaims.reduce((s: number, c: any) => s + Number(c.credit_cents ?? 0), 0);

      const definitions = decisions.map(({ qualified, heldByInvestigation, ...definition }) => {
        const claim = claimedByTier.get(definition.tier);
        const legacyPaid = legacyMonetaryTiers.has(definition.tier);
        const earnedBadge = awards.rows.some(award => award.milestone_id === definition.tier && award.state === 'qualified');
        const state = claim || legacyPaid
          ? 'CLAIMED'
          : heldByInvestigation
            ? 'UNDER_INVESTIGATION'
            : qualified
              ? bonusSwitchOn
                ? 'CLAIMABLE'
                : earnedBadge ? 'EARNED' : 'QUALIFIED'
              : !evidence.totalCampaigns
                ? 'LOCKED'
                : !evidence.fundingVerified || pending
                  ? 'PENDING_CLEARANCE'
                  : 'IN_PROGRESS';
        return { ...definition, state, claimed: Boolean(claim || legacyPaid), heldByInvestigation };
      });

      const claimableRewards = definitions
        .filter(d => bonusSwitchOn && !d.claimed && decisions.find(dec => dec.tier === d.tier)?.qualified)
        .map(d => ({
          milestoneId: d.tier,
          title: d.title,
          bonusCreditCents: d.bonusCreditCents,
          maxPromoterEarningsCents: d.maxPromoterEarningsCents,
          isPrestige: d.isPrestige,
        }));

      return {
        policyVersion: recognitionPolicyVersion,
        evaluatedAt: new Date().toISOString(),
        monetaryProgram: {
          status: !bonusSwitchOn
            ? 'paused_by_admin'
            : !deliverySwitchOn
              ? 'claims_active_delivery_paused'
              : promoRemainingCents <= 0
                ? 'claims_active_reserve_pacing'
                : 'active',
          bonusClaimsEnabled: bonusSwitchOn,
          bonusDeliveryEnabled: deliverySwitchOn,
          promotionalReserveAvailableCents: promoRemainingCents,
          reason: !bonusSwitchOn
            ? 'Advertiser bonus credit claims are currently paused by Platform Admin.'
            : promoRemainingCents <= 0
              ? 'Bonus credit claims are active (no expiry). 100% bonus-credit campaign delivery paces automatically once Promotional Ad Reserve funds are available.'
              : 'Advertiser bonus credit program is active: claim unlocked tiers anytime (no deadline, no expiry) and launch 100% bonus-credit campaigns on unsold inventory.',
        },
        progress: {
          totalCampaigns: evidence.totalCampaigns,
          completedCampaignsAwaitingVerification: pending,
          verifiedCompletedCampaigns: evidence.fundingVerified || !evidence.totalCampaigns ? eligible.length : null,
          eligibleClearedSpendCents: (evidence.fundingVerified || !evidence.totalCampaigns) && Number.isSafeInteger(spend) ? spend : null,
          tenureMonths: evidence.tenureMonths ?? 0,
          complianceClean: evidence.complianceClean === true,
          underInvestigation: evidence.underInvestigation === true,
          evidenceStatus: !evidence.totalCampaigns ? 'no_activity' : !evidence.fundingVerified || pending ? 'pending_verification' : 'verified',
          explanation: !evidence.totalCampaigns
            ? 'Run an approved cash-funded campaign to begin your post-launch milestone progress.'
            : !evidence.fundingVerified
              ? 'Funding history needs verification before campaign spend can qualify.'
              : pending
                ? 'Some campaigns are awaiting settlement clearance or eligibility review.'
                : 'Progress reflects verified cash funding and post-launch cleared cash spend.',
        },
        definitions,
        badges: awards.rows.map(award => {
          const def = milestoneDefinitions.find(d => d.tier === award.milestone_id);
          const dec = decisions.find(decision => decision.tier === award.milestone_id);
          // Permanent Prestige: never revoke a qualified Prestige badge unless confirmed fraud occurred
          const preservePermanentPrestige =
            Boolean(def?.isPrestige) && award.state === 'qualified' && !evidence.confirmedFraud;
          return {
            id: award.id,
            tier: award.milestone_id,
            achievedAt: award.first_qualified_at,
            state: preservePermanentPrestige || dec?.qualified
              ? award.state
              : !evidence.fundingVerified || pending || evidence.underInvestigation
                ? 'under_review'
                : 'revoked',
          };
        }),
        bonusWallet: {
          availableBonusCreditCents: availableBonusCents,
          reservedBonusCreditCents: reservedBonusCents,
          consumedBonusCreditCents: consumedBonusCents,
          lifetimeClaimedCents,
          lifetimeMaxCents: BONUS_CREDIT_LIFETIME_MAX_CENTS,
          claims: bonusClaims.map((c: any) => ({
            id: c.id,
            milestoneId: c.milestone_id,
            creditCents: Number(c.credit_cents),
            remainingCreditCents: Number(c.remaining_credit_cents),
            reservedCreditCents: Number(c.reserved_credit_cents),
            consumedCreditCents: Number(c.consumed_credit_cents),
            state: c.state,
            claimedAt: c.claimed_at,
          })),
        },
        achievements: achievements.map(achievement => ({ ...achievement, status: 'RECONCILIATION_REQUIRED' })),
        claimableRewards,
        totalBonusCreditRemainingCents: bonusClaims.length > 0 ? availableBonusCents : null,
        totalBonusCreditRemainingUsd: bonusClaims.length > 0 ? Number((availableBonusCents / 100).toFixed(2)) : null,
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  /** Recognition writes + silent admin alert on post-award anomaly (never automatic clawback; preserves permanent prestige). */
  async evaluateCategoryAMilestones(advertiserId: string) {
    this.validateIdentity(advertiserId);
    const newlyAwarded = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'advertiser-recognition:' + advertiserId},0))`);
      const evidence = await readMilestoneEvidence(tx, advertiserId);
      const decisions = recognitionDecisions(evidence);
      const proof = JSON.stringify({
        fundingVerified: evidence.fundingVerified,
        tenureMonths: evidence.tenureMonths ?? 0,
        complianceClean: evidence.complianceClean === true,
        underInvestigation: evidence.underInvestigation === true,
        campaigns: evidence.campaigns.filter(campaign => campaign.eligible).sort((left, right) => left.id.localeCompare(right.id)),
      });
      const awarded: { id: string; tier: string }[] = [];
      for (const decision of decisions) {
        const prior = await tx.execute<{ id: string; state: string }>(sql`
          SELECT id,state FROM advertiser_recognition_awards WHERE advertiser_id=${advertiserId}::uuid
            AND milestone_id=${decision.tier} AND qualifying_scope='lifetime' FOR UPDATE`);
        if (!prior.rows.length && !decision.qualified) continue;
        const preservePrestige =
          decision.isPrestige && prior.rows[0]?.state === 'qualified' && !evidence.confirmedFraud;
        const state = preservePrestige || decision.qualified
          ? 'qualified'
          : !evidence.fundingVerified || evidence.underInvestigation || evidence.campaigns.some(campaign => (campaign.qualifying ?? campaign.completed) && !campaign.eligible)
            ? 'under_review'
            : 'revoked';
        if (!prior.rows.length) {
          const created = await tx.execute<{ id: string }>(sql`INSERT INTO advertiser_recognition_awards(advertiser_id,milestone_id,qualifying_scope,policy_version,state,evidence)
            VALUES (${advertiserId}::uuid,${decision.tier},'lifetime',${recognitionPolicyVersion},${state},${proof}::jsonb) RETURNING id`);
          const id = created.rows[0].id;
          await tx.execute(sql`INSERT INTO advertiser_recognition_evaluations(award_id,state,policy_version,evidence)
            VALUES (${id}::uuid,${state},${recognitionPolicyVersion},${proof}::jsonb)`);
          awarded.push({ id, tier: decision.tier });
        } else {
          const changed = await tx.execute<{ id: string }>(sql`WITH changed AS (
            UPDATE advertiser_recognition_awards SET state=${state},policy_version=${recognitionPolicyVersion},evidence=${proof}::jsonb,evaluated_at=now()
            WHERE id=${prior.rows[0].id}::uuid AND (state<>${state} OR evidence IS DISTINCT FROM ${proof}::jsonb OR policy_version<>${recognitionPolicyVersion}) RETURNING id
          ) INSERT INTO advertiser_recognition_evaluations(award_id,previous_state,state,policy_version,evidence)
            SELECT id,${prior.rows[0].state},${state},${recognitionPolicyVersion},${proof}::jsonb FROM changed RETURNING award_id AS id`);

          if (prior.rows[0].state === 'qualified' && state !== 'qualified' && changed.rows.length > 0) {
            try {
              await tx.execute(
                sql`INSERT INTO platform_admin_silent_alerts (category, severity, advertiser_id, milestone_id, summary, details)
                    VALUES ('post_award_anomaly', 'warning', ${advertiserId}::uuid, ${decision.tier}, ${`Advertiser ${decision.tier} eligibility changed after prior award; no automatic clawback performed.`}, ${proof}::jsonb)`,
              );
            } catch {
              // Silent alert failure never rolls back recognition audit
            }
          }
        }
      }
      return awarded;
    });
    return { status: 'evaluated', newlyAwarded, ...await this.getAdvertiserAchievements(advertiserId) };
  }

  /** Explicit manual claim of an unlocked milestone's bonus ad credit (no deadline, no expiry). */
  async claimMilestoneBonus(
    advertiserId: string,
    input: { milestoneId: string; requestId: string; acceptTerms?: boolean },
  ) {
    this.validateIdentity(advertiserId);
    if (typeof input?.requestId !== 'string' || !UUID_RE.test(input.requestId)) {
      throw new BadRequestException('Valid requestId UUID required');
    }
    if (input.acceptTerms !== true) {
      throw new BadRequestException('You must accept the non-withdrawable Bonus Ad Credit terms before claiming');
    }
    const def = milestoneDefinitions.find(d => d.tier === input.milestoneId);
    if (!def) {
      throw new NotFoundException(`Unknown milestone: ${input.milestoneId}`);
    }

    const claimResult = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'advertiser-claim:' + advertiserId}, 0))`,
      );

      if (!(await this.safeSwitchEnabled('advertiser_bonus_credit', tx))) {
        throw new ConflictException('Advertiser bonus ad credit claiming is currently paused by Platform Admin');
      }

      const byRequest = rows(
        await tx.execute(
          sql`SELECT id, advertiser_id, milestone_id, credit_cents, remaining_credit_cents, state, claimed_at
              FROM advertiser_bonus_credits WHERE request_id = ${input.requestId}::uuid LIMIT 1`,
        ),
      )[0];
      if (byRequest) {
        if (byRequest.advertiser_id !== advertiserId || byRequest.milestone_id !== input.milestoneId) {
          throw new ConflictException('Bonus claim request identity mismatch');
        }
        return byRequest;
      }

      const alreadyClaimed = rows(
        await tx.execute(
          sql`SELECT id FROM advertiser_bonus_credits WHERE advertiser_id = ${advertiserId}::uuid AND milestone_id = ${input.milestoneId} FOR UPDATE`,
        ),
      )[0];
      if (alreadyClaimed) {
        throw new ConflictException('This milestone bonus credit has already been claimed (once per lifetime)');
      }

      // G06: Prevent a second lifetime monetary award if verified legacy monetary credit was already granted
      const legacyMonetary = rows(
        await tx.execute(
          sql`SELECT id FROM advertiser_achievements
              WHERE advertiser_id = ${advertiserId}::uuid
                AND tier = ${input.milestoneId}
                AND bonus_credit_cents > 0
                AND is_clawed_back = false
              LIMIT 1`,
        ),
      )[0];
      if (legacyMonetary) {
        throw new ConflictException(
          'A prior lifetime monetary bonus award already exists for this milestone tier',
        );
      }

      const evidence = await readMilestoneEvidence(tx, advertiserId);
      const decision = recognitionDecisions(evidence).find(d => d.tier === input.milestoneId);
      if (decision?.heldByInvestigation) {
        throw new ConflictException(
          `Milestone ${input.milestoneId} claim is temporarily awaiting compliance investigation review`,
        );
      }
      if (!decision?.qualified) {
        throw new ConflictException(`Milestone ${input.milestoneId} requirements are not yet satisfied`);
      }

      // G06: Ensure permanent badge award record AND evaluation audit history are appended atomically
      const awardEvidenceJson = JSON.stringify({
        cumulativeSpendCents: decision.cumulativeSpendCents,
        source: 'claim',
        requestId: input.requestId,
      });
      const newAward = rows(
        await tx.execute(
          sql`INSERT INTO advertiser_recognition_awards(advertiser_id, milestone_id, qualifying_scope, policy_version, state, evidence)
              VALUES (${advertiserId}::uuid, ${input.milestoneId}, 'lifetime', ${recognitionPolicyVersion}, 'qualified', ${awardEvidenceJson}::jsonb)
              ON CONFLICT (advertiser_id, milestone_id, qualifying_scope) DO NOTHING
              RETURNING id`,
        ),
      )[0];
      if (newAward?.id) {
        await tx.execute(
          sql`INSERT INTO advertiser_recognition_evaluations(award_id, state, policy_version, evidence)
              VALUES (${newAward.id}::uuid, 'qualified', ${recognitionPolicyVersion}, ${awardEvidenceJson}::jsonb)`,
        );
      }

      const [claimed] = rows(
        await tx.execute(
          sql`INSERT INTO advertiser_bonus_credits
                (advertiser_id, milestone_id, request_id, policy_version, qualifying_spend_cents, credit_cents, remaining_credit_cents, reserved_credit_cents, consumed_credit_cents, state)
              VALUES
                (${advertiserId}::uuid, ${input.milestoneId}, ${input.requestId}::uuid, ${recognitionPolicyVersion}, ${decision.cumulativeSpendCents}, ${def.bonusCreditCents}, ${def.bonusCreditCents}, 0, 0, 'available')
              RETURNING id, advertiser_id, milestone_id, credit_cents, remaining_credit_cents, reserved_credit_cents, consumed_credit_cents, state, claimed_at`,
        ),
      );

      const balanceAfter = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(remaining_credit_cents), 0)::int AS total FROM advertiser_bonus_credits WHERE advertiser_id = ${advertiserId}::uuid`,
        ),
      )[0]?.total ?? def.bonusCreditCents;

      await tx.execute(
        sql`INSERT INTO advertiser_bonus_ledger (advertiser_id, credit_id, request_id, kind, amount_cents, balance_after_cents, metadata)
            VALUES (${advertiserId}::uuid, ${claimed.id}::uuid, ${input.requestId}::uuid, 'claim', ${def.bonusCreditCents}, ${balanceAfter}, ${JSON.stringify({ milestoneId: input.milestoneId, noExpiry: true })}::jsonb)`,
      );

      await tx.execute(
        sql`UPDATE advertiser_promo_budget
            SET issued_bonus_credits_cents = issued_bonus_credits_cents + ${def.bonusCreditCents},
                updated_at = now()
            WHERE id = (SELECT id FROM advertiser_promo_budget ORDER BY updated_at DESC LIMIT 1)`,
      );

      return claimed;
    });

    return {
      claim: claimResult,
      ...(await this.getAdvertiserAchievements(advertiserId)),
    };
  }

  /**
   * Atomically reserve available bonus credit when launching/resuming a 100% bonus-credit campaign (PLAN-0155 G05).
   * Binds deterministic per-grant request identities and records per-campaign allocations so release & consumption
   * reconcile 1:1 to the exact source grants.
   */
  async reserveBonusForCampaignTx(
    tx: any,
    advertiserId: string,
    campaignId: string,
    amountCents: number,
    requestId: string,
  ) {
    this.validateIdentity(advertiserId);
    if (!UUID_RE.test(campaignId) || !UUID_RE.test(requestId)) {
      throw new BadRequestException('Valid campaignId and requestId UUIDs required');
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('Bonus campaign budget must be a positive integer USD cents');
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'advertiser-claim:' + advertiserId}, 0))`,
    );

    const priorEntries = rows(
      await tx.execute(
        sql`SELECT campaign_id, amount_cents
            FROM advertiser_bonus_ledger
            WHERE advertiser_id = ${advertiserId}::uuid
              AND kind = 'campaign_reserve'
              AND metadata->>'parentRequestId' = ${requestId}`,
      ),
    );
    if (priorEntries.length > 0) {
      const priorTotal = priorEntries.reduce((sum, e) => sum + Math.abs(Number(e.amount_cents)), 0);
      if (priorEntries.some(e => e.campaign_id !== campaignId) || priorTotal !== amountCents) {
        throw new ConflictException('Bonus campaign reservation request identity conflict');
      }
      return;
    }

    const credits = rows(
      await tx.execute(
        sql`SELECT id, remaining_credit_cents, reserved_credit_cents, consumed_credit_cents
            FROM advertiser_bonus_credits
            WHERE advertiser_id = ${advertiserId}::uuid AND remaining_credit_cents > 0 AND state = 'available'
            ORDER BY claimed_at ASC, id ASC FOR UPDATE`,
      ),
    );
    const totalAvailable = credits.reduce((s: number, c: any) => s + Number(c.remaining_credit_cents), 0);
    if (totalAvailable < amountCents) {
      throw new ConflictException(
        `Insufficient bonus ad credit ($${(totalAvailable / 100).toFixed(2)} available, $${(amountCents / 100).toFixed(2)} required).`,
      );
    }

    let left = amountCents;
    let runningBalance = totalAvailable;
    for (const c of credits) {
      if (left <= 0) break;
      const take = Math.min(left, Number(c.remaining_credit_cents));
      await tx.execute(
        sql`UPDATE advertiser_bonus_credits
            SET remaining_credit_cents = remaining_credit_cents - ${take},
                reserved_credit_cents = reserved_credit_cents + ${take}
            WHERE id = ${c.id}::uuid`,
      );
      await tx.execute(
        sql`INSERT INTO advertiser_bonus_campaign_allocations
              (campaign_id, credit_id, advertiser_id, allocated_cents, reserved_cents, consumed_cents, released_cents, consumed_microusd)
            VALUES
              (${campaignId}::uuid, ${c.id}::uuid, ${advertiserId}::uuid, ${take}, ${take}, 0, 0, 0)
            ON CONFLICT (campaign_id, credit_id) DO UPDATE
              SET allocated_cents = advertiser_bonus_campaign_allocations.allocated_cents + ${take},
                  reserved_cents = advertiser_bonus_campaign_allocations.reserved_cents + ${take},
                  updated_at = now()`,
      );
      runningBalance -= take;
      left -= take;
      const ledgerReqId = deterministicBonusLedgerUuid('reserve', requestId, String(c.id));
      await tx.execute(
        sql`INSERT INTO advertiser_bonus_ledger (advertiser_id, credit_id, campaign_id, request_id, kind, amount_cents, balance_after_cents, metadata)
            VALUES (${advertiserId}::uuid, ${c.id}::uuid, ${campaignId}::uuid, ${ledgerReqId}::uuid, 'campaign_reserve', ${-take}, ${runningBalance}, ${JSON.stringify({ parentRequestId: requestId })}::jsonb)`,
      );
    }

    await tx.execute(
      sql`INSERT INTO platform_admin_silent_alerts (category, severity, advertiser_id, campaign_id, summary, details)
          VALUES ('full_bonus_campaign', 'info', ${advertiserId}::uuid, ${campaignId}::uuid,
                  ${`100% bonus-credit campaign submitted ($${(amountCents / 100).toFixed(2)}). Non-blocking silent safety notice.`},
                  ${JSON.stringify({ amountCents, requestId })}::jsonb)`,
    );
  }

  /**
   * Atomically release unspent bonus credit back strictly from THIS campaign's allocations (PLAN-0155 G05).
   * Preserves concurrent allocations belonging to other campaigns owned by the same advertiser.
   */
  async releaseUnusedBonusForCampaignTx(
    tx: any,
    advertiserId: string,
    campaignId: string,
    releaseCents: number,
    reason: string,
    requestId?: string,
  ) {
    if (releaseCents <= 0) return 0;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'advertiser-claim:' + advertiserId}, 0))`,
    );

    if (requestId && UUID_RE.test(requestId)) {
      const priorRelease = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(amount_cents), 0)::int AS released
              FROM advertiser_bonus_ledger
              WHERE advertiser_id = ${advertiserId}::uuid
                AND campaign_id = ${campaignId}::uuid
                AND kind = 'campaign_release'
                AND metadata->>'parentRequestId' = ${requestId}`,
        ),
      )[0];
      if (Number(priorRelease?.released ?? 0) > 0) {
        return Number(priorRelease.released);
      }
    }

    const allocations = rows(
      await tx.execute(
        sql`SELECT a.id, a.credit_id, a.reserved_cents, a.released_cents
            FROM advertiser_bonus_campaign_allocations a
            WHERE a.campaign_id = ${campaignId}::uuid
              AND a.advertiser_id = ${advertiserId}::uuid
              AND a.reserved_cents > 0
            ORDER BY a.created_at DESC, a.id DESC
            FOR UPDATE`,
      ),
    );

    let left = releaseCents;
    let released = 0;
    const scopeKey = requestId && UUID_RE.test(requestId) ? requestId : `${campaignId}:${Date.now()}`;

    for (const alloc of allocations) {
      if (left <= 0) break;
      const give = Math.min(left, Number(alloc.reserved_cents));
      if (give <= 0) continue;

      await tx.execute(
        sql`UPDATE advertiser_bonus_campaign_allocations
            SET reserved_cents = reserved_cents - ${give},
                released_cents = released_cents + ${give},
                updated_at = now()
            WHERE id = ${alloc.id}::uuid`,
      );
      await tx.execute(
        sql`UPDATE advertiser_bonus_credits
            SET remaining_credit_cents = remaining_credit_cents + ${give},
                reserved_credit_cents = reserved_credit_cents - ${give}
            WHERE id = ${alloc.credit_id}::uuid`,
      );
      left -= give;
      released += give;
      const balanceAfter = rows(
        await tx.execute(
          sql`SELECT coalesce(sum(remaining_credit_cents), 0)::int AS total
              FROM advertiser_bonus_credits
              WHERE advertiser_id = ${advertiserId}::uuid`,
        ),
      )[0]?.total ?? 0;
      const ledgerReqId = deterministicBonusLedgerUuid(
        'release',
        scopeKey,
        String(alloc.credit_id),
        String(Number(alloc.released_cents) + give),
      );
      await tx.execute(
        sql`INSERT INTO advertiser_bonus_ledger (advertiser_id, credit_id, campaign_id, request_id, kind, amount_cents, balance_after_cents, metadata)
            VALUES (${advertiserId}::uuid, ${alloc.credit_id}::uuid, ${campaignId}::uuid, ${ledgerReqId}::uuid, 'campaign_release', ${give}, ${balanceAfter}, ${JSON.stringify({ reason, parentRequestId: requestId ?? null })}::jsonb)
            ON CONFLICT (request_id) DO NOTHING`,
      );
    }
    return released;
  }

  async reconcile(after: string | null, persist: boolean, assertLease: () => Promise<void>) {
    const result = await this.db.execute<{ advertiser_id: string }>(sql`SELECT advertiser_id FROM (
      SELECT advertiser_id FROM ads_campaigns UNION SELECT advertiser_id FROM advertiser_recognition_awards
    ) owners WHERE ${after ? sql`advertiser_id>${after}::uuid` : sql`true`} ORDER BY advertiser_id LIMIT 100`);
    for (const row of result.rows) {
      await assertLease();
      if (persist) await this.evaluateCategoryAMilestones(row.advertiser_id);
      else await this.getAdvertiserAchievements(row.advertiser_id);
    }
    return { processed: result.rows.length, cursor: result.rows.length === 100 ? result.rows[result.rows.length - 1].advertiser_id : null };
  }
}
