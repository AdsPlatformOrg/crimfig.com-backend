import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { canonicalPaidRewardLoops, earnedLoopDelta } from '../../../shared/src/rewards-performance-policy';
import { verifyAssessmentRecord } from './event-cash-rebate-reconciliation';

export interface PaidPointsCohortPreview {
  promoterUserId: string;
  model: 'cpc' | 'cpm';
  eligibleEvents: string;
  issuedPoints: string;
  entitledPoints: string;
  unsupportedPoints: string;
}

export interface PaidPointsReconciliationSummary {
  cohortsEvaluated: number;
  reversedCohorts: number;
  reversedPoints: string;
  recoveryCasesCreated: number;
  shortfallPointsRecorded: string;
  restoredCohorts: number;
  restoredPoints: string;
}

interface CohortInspection extends PaidPointsCohortPreview {
  version: string;
  rawIssuedPoints: bigint;
  netLedgerCorrection: bigint;
  recordedShortfall: bigint;
  latestIssueId: string | null;
  latestInvalidAssessmentId: string | null;
  latestInvalidActorId: string | null;
  latestAssessmentId: string | null;
  latestActorId: string | null;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function rateVersionNumber(version: string): number {
  const parsed = Number.parseInt(String(version).replace(/\D+/g, ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function parseShortfallFromReason(reason: string): bigint {
  const match = /:shortfall=(\d+)$/.exec(reason);
  if (!match) return 0n;
  return BigInt(match[1]);
}

async function detectOptionalTables(executor: Pick<NodePgDatabase<typeof schema>, 'execute'>) {
  const res = await executor.execute<{
    assessments: string | null;
    ledger: string | null;
    recovery: string | null;
  }>(sql`
    SELECT
      to_regclass('public.ads_event_assessments')::text AS assessments,
      to_regclass('public.rewards_points_ledger')::text AS ledger,
      to_regclass('public.reward_recovery_cases')::text AS recovery
  `);
  const row = ((res as any).rows ?? res)[0];
  return {
    hasAssessments: Boolean(row?.assessments),
    hasLedger: Boolean(row?.ledger),
    hasRecovery: Boolean(row?.recovery),
  };
}

async function inspectPaidCohorts(
  executor: Pick<NodePgDatabase<typeof schema>, 'execute'>,
  windows: { lower: string; upper: string },
  includeObserved: boolean,
  env = process.env,
): Promise<CohortInspection[]> {
  const { hasAssessments, hasLedger, hasRecovery } = await detectOptionalTables(executor);
  const version = canonicalPaidRewardLoops().version;

  const cohortRes = await executor.execute<{
    user_id: string;
    model: 'cpc' | 'cpm';
    version: string;
  }>(sql`
    with affected as (
      select distinct receipt.user_id, receipt.model, receipt.payload->>'rateVersion' as version
      from ads_interactions event
      join reward_performance_receipts receipt on receipt.event_id = event.id
      where not event.is_valid and event.created_at >= ${windows.lower}::timestamptz
        and event.created_at < ${windows.upper}::timestamptz
        and receipt.payload->>'rateVersion' = ${version}
      ${hasAssessments ? sql`
        union
        select distinct receipt.user_id, receipt.model, receipt.payload->>'rateVersion' as version
        from ads_event_assessments a
        join reward_performance_receipts receipt on receipt.event_id = a.event_id
        where a.created_at >= ${windows.lower}::timestamptz
          and a.created_at <= ${windows.upper}::timestamptz
          and receipt.payload->>'rateVersion' = ${version}
      ` : sql``}
      ${includeObserved ? sql`
        union
        select distinct user_id, model, rate_version as version from reward_points_correction_observations
        where rate_version = ${version}
      ` : sql``}
      order by user_id, model limit 50
    )
    select user_id, model, version from affected order by user_id, model
  `);

  const cohorts = ((cohortRes as any).rows ?? cohortRes) as Array<{
    user_id: string;
    model: 'cpc' | 'cpm';
    version: string;
  }>;

  const inspections: CohortInspection[] = [];

  for (const cohort of cohorts) {
    const eventsRes = await executor.execute<{
      event_id: string;
      is_valid: boolean;
      issue_id: string | null;
      issue_points: string | null;
      assessment: any | null;
    }>(sql`
      select
        event.id as event_id,
        event.is_valid,
        (row_to_json(issue)->>'id') as issue_id,
        coalesce(issue.points, 0)::text as issue_points,
        ${hasAssessments ? sql`row_to_json(latest_a)` : sql`null::json`} as assessment
      from reward_performance_receipts receipt
      join ads_interactions event on event.id = receipt.event_id
      left join reward_program_issues issue on issue.source_ref = 'paid-loop:' || event.id::text
        and issue.kind = 'paid_loop' and issue.user_id = ${cohort.user_id}
      ${hasAssessments ? sql`
        left join lateral (
          select id, event_id, campaign_id, request_id, actor_id, policy_version, outcome, reason_codes, features, supersedes_id, record_hash, key_id, created_at
          from ads_event_assessments a
          where a.event_id = event.id
          order by a.created_at desc, a.id desc
          limit 1
        ) latest_a on true
      ` : sql``}
      where receipt.user_id = ${cohort.user_id}
        and receipt.model = ${cohort.model}
        and receipt.payload->>'rateVersion' = ${cohort.version}
      order by event.created_at desc, event.id desc
    `);

    const eventRows = ((eventsRes as any).rows ?? eventsRes) as Array<{
      event_id: string;
      is_valid: boolean;
      issue_id: string | null;
      issue_points: string | null;
      assessment: any | null;
    }>;

    let validCount = 0n;
    let rawIssued = 0n;
    let latestIssueId: string | null = null;
    let latestInvalidAssessmentId: string | null = null;
    let latestInvalidActorId: string | null = null;
    let latestAssessmentId: string | null = null;
    let latestActorId: string | null = null;
    let latestInvalidCreatedAt = 0;
    let latestAssessmentCreatedAt = 0;

    for (const row of eventRows) {
      if (row.issue_id && !latestIssueId) latestIssueId = row.issue_id;
      rawIssued += BigInt(row.issue_points ?? '0');

      const a = row.assessment;
      if (a) {
        const verified = verifyAssessmentRecord(
          {
            id: a.id,
            eventId: a.event_id,
            campaignId: a.campaign_id ?? null,
            requestId: a.request_id,
            actorId: a.actor_id,
            policyVersion: a.policy_version,
            outcome: a.outcome,
            reasonCodes: a.reason_codes,
            features: a.features,
            supersedesId: a.supersedes_id ?? null,
            keyId: a.key_id,
            recordHash: a.record_hash,
          },
          env,
        );
        if (!verified) {
          throw new Error(`Invalid assessment evidence signature for paid event ${row.event_id} (${a.id})`);
        }
        const aTime = new Date(a.created_at).getTime();
        if (aTime >= latestAssessmentCreatedAt) {
          latestAssessmentCreatedAt = aTime;
          latestAssessmentId = a.id;
          latestActorId = a.actor_id;
        }
        if (a.outcome === 'invalid' && aTime >= latestInvalidCreatedAt) {
          latestInvalidCreatedAt = aTime;
          latestInvalidAssessmentId = a.id;
          latestInvalidActorId = a.actor_id;
        }
        const eligible = a.outcome === 'eligible' && (row.is_valid || Boolean(a.supersedes_id));
        if (eligible) validCount += 1n;
      } else if (row.is_valid) {
        validCount += 1n;
      }
    }

    let netLedgerCorrection = 0n;
    if (hasLedger) {
      const ledgerRes = await executor.execute<{ net: string }>(sql`
        select coalesce(sum(delta_points), 0)::text as net
        from rewards_points_ledger
        where user_id = ${cohort.user_id}
          and activity_code in ('reward_points_reversal', 'reward_points_restore')
          and source_ref like ${`paid-cohort:${cohort.model}:${cohort.version}:%`}
      `);
      const ledgerRows = ((ledgerRes as any).rows ?? ledgerRes) as Array<{ net: string }>;
      netLedgerCorrection = BigInt(ledgerRows[0]?.net ?? '0');
    }

    let recordedShortfall = 0n;
    if (hasRecovery) {
      const recoveryRes = await executor.execute<{ reason: string }>(sql`
        select rc.reason
        from reward_recovery_cases rc
        join reward_program_issues issue on issue.id = rc.issue_id
        where issue.user_id = ${cohort.user_id}
          and rc.reason like ${`paid_points_redeemed_shortfall:${cohort.model}:${cohort.version}:shortfall=%`}
      `);
      const recoveryRows = ((recoveryRes as any).rows ?? recoveryRes) as Array<{ reason: string }>;
      for (const rr of recoveryRows) {
        recordedShortfall += parseShortfallFromReason(rr.reason);
      }
    }

    const entitlement = BigInt(earnedLoopDelta(cohort.model, 0n, validCount).potentialPoints);
    const activeNetIssued = rawIssued + netLedgerCorrection - recordedShortfall;
    const effectiveIssued = activeNetIssued > 0n ? activeNetIssued : 0n;

    inspections.push({
      promoterUserId: cohort.user_id,
      model: cohort.model,
      version: cohort.version,
      eligibleEvents: validCount.toString(),
      issuedPoints: effectiveIssued.toString(),
      entitledPoints: entitlement.toString(),
      unsupportedPoints: (effectiveIssued > entitlement ? effectiveIssued - entitlement : 0n).toString(),
      rawIssuedPoints: rawIssued,
      netLedgerCorrection,
      recordedShortfall,
      latestIssueId,
      latestInvalidAssessmentId,
      latestInvalidActorId,
      latestAssessmentId,
      latestActorId,
    });
  }

  return inspections;
}

export async function paidPointsCorrectionPreview(
  db: Pick<NodePgDatabase<typeof schema>, 'execute'>,
  windows: { lower: string; upper: string },
  includeObserved = false,
  env = process.env,
): Promise<PaidPointsCohortPreview[]> {
  const inspections = await inspectPaidCohorts(db, windows, includeObserved, env);
  return inspections.map((row) => ({
    promoterUserId: row.promoterUserId,
    model: row.model,
    eligibleEvents: row.eligibleEvents,
    issuedPoints: row.issuedPoints,
    entitledPoints: row.entitledPoints,
    unsupportedPoints: row.unsupportedPoints,
  }));
}

export async function recordPaidPointsCorrectionObservations(
  db: Pick<NodePgDatabase<typeof schema>, 'execute'> & Pick<NodePgDatabase<typeof schema>, 'transaction'>,
  window: { lower: string; upper: string },
  env = process.env,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rewards:points-correction-observations'))`);
    const previews = await paidPointsCorrectionPreview(tx, window, true, env);
    const version = canonicalPaidRewardLoops().version;
    for (const cohort of previews) {
      await tx.execute(sql`
        insert into reward_points_correction_observations
          (user_id, model, rate_version, eligible_events, issued_points, entitled_points, unsupported_points)
        select ${cohort.promoterUserId}, ${cohort.model}, ${version}, ${cohort.eligibleEvents}::bigint,
          ${cohort.issuedPoints}::bigint, ${cohort.entitledPoints}::bigint, ${cohort.unsupportedPoints}::bigint
        where (${cohort.unsupportedPoints}::bigint > 0 or exists (
          select 1 from reward_points_correction_observations
          where user_id = ${cohort.promoterUserId} and model = ${cohort.model} and rate_version = ${version}
        )) and not exists (
          select 1 from (
            select eligible_events, issued_points, entitled_points, unsupported_points
            from reward_points_correction_observations
            where user_id = ${cohort.promoterUserId} and model = ${cohort.model} and rate_version = ${version}
            order by created_at desc, id desc limit 1
          ) prior
          where prior.eligible_events = ${cohort.eligibleEvents}::bigint
            and prior.issued_points = ${cohort.issuedPoints}::bigint
            and prior.entitled_points = ${cohort.entitledPoints}::bigint
            and prior.unsupported_points = ${cohort.unsupportedPoints}::bigint
        )
      `);
    }
    return previews;
  });
}

/**
 * Reconciles unsupported redeemable paid-loop points and overturned invalidations.
 * - Deducts pending then available points without ever going negative.
 * - Releases Rewards Fund backing to available_usd_cents via rewards_fund_ledger (type='release')
 *   only when funded_pending_usd_cents / allocated_usd_cents suffice.
 * - Records already-redeemed shortfalls in reward_recovery_cases.
 * - Restores overturned invalidations once when sufficient Rewards Fund available backing exists.
 */
export async function reconcilePaidPointsCorrections(
  db: NodePgDatabase<typeof schema>,
  window: { lower: string; upper: string },
  env = process.env,
): Promise<PaidPointsReconciliationSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cfig:global-allocation', 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('rewards-fund:USD', 0))`);

    const hasObsRes = await tx.execute<{ obs: string | null }>(
      sql`select to_regclass('public.reward_points_correction_observations')::text as obs`,
    );
    const hasObs = Boolean(((hasObsRes as any).rows ?? hasObsRes)[0]?.obs);

    const cohorts = await inspectPaidCohorts(tx, window, hasObs, env);
    const now = new Date();

    const summary: PaidPointsReconciliationSummary = {
      cohortsEvaluated: cohorts.length,
      reversedCohorts: 0,
      reversedPoints: '0',
      recoveryCasesCreated: 0,
      shortfallPointsRecorded: '0',
      restoredCohorts: 0,
      restoredPoints: '0',
    };

    let reversedTotal = 0n;
    let shortfallTotal = 0n;
    let restoredTotal = 0n;

    for (const cohort of cohorts) {
      const entitled = BigInt(cohort.entitledPoints);
      const maxCohortPoints =
        cohort.rawIssuedPoints > cohort.recordedShortfall
          ? cohort.rawIssuedPoints - cohort.recordedShortfall
          : 0n;
      const desired = entitled < maxCohortPoints ? entitled : maxCohortPoints;
      const currentNet = cohort.rawIssuedPoints + cohort.netLedgerCorrection - cohort.recordedShortfall;

      if (currentNet === desired) continue;

      const balRes = await tx.execute<{
        id: string;
        pending_points: number;
        available_points: number;
      }>(sql`
        select id, pending_points, available_points
        from rewards_points_balances
        where user_id = ${cohort.promoterUserId}
        for update
      `);
      const bal = ((balRes as any).rows ?? balRes)[0];

      const fundRes = await tx.execute<{
        id: string;
        cash_balance_usd_cents: string;
        available_usd_cents: string;
        allocated_usd_cents: string;
        funded_pending_usd_cents: string;
      }>(sql`
        select id, cash_balance_usd_cents, available_usd_cents, allocated_usd_cents, funded_pending_usd_cents
        from rewards_fund
        where currency = 'USD'
        for update
      `);
      let fund = ((fundRes as any).rows ?? fundRes)[0];

      if (currentNet > desired) {
        const toReverse = currentNet - desired;
        const pendingAvail = BigInt(Math.max(0, bal?.pending_points ?? 0));
        const availAvail = BigInt(Math.max(0, bal?.available_points ?? 0));

        const reclaimPending = toReverse < pendingAvail ? toReverse : pendingAvail;
        const remainderAfterPending = toReverse - reclaimPending;
        const reclaimAvailable = remainderAfterPending < availAvail ? remainderAfterPending : availAvail;
        const totalReclaimed = reclaimPending + reclaimAvailable;
        const shortfall = toReverse - totalReclaimed;

        const triggerId = cohort.latestInvalidAssessmentId ?? cohort.latestAssessmentId ?? 'manual-invalid';
        const revRateVer = rateVersionNumber(cohort.version);
        const cohortLotId = `paid-cohort:${cohort.model}:${cohort.version}:${cohort.promoterUserId.slice(0, 8)}`;

        if (totalReclaimed > 0n && bal) {
          const nextPending = bal.pending_points - Number(reclaimPending);
          const nextAvailable = bal.available_points - Number(reclaimAvailable);
          if (nextPending < 0 || nextAvailable < 0) {
            throw new Error(`Negative points balance prevented for user ${cohort.promoterUserId}`);
          }
          await tx.execute(sql`
            update rewards_points_balances
            set pending_points = ${nextPending},
                available_points = ${nextAvailable},
                version = version + 1,
                updated_at = ${now}
            where id = ${bal.id}
          `);

          if (reclaimPending > 0n) {
            const sourceRef = `paid-cohort:${cohort.model}:${cohort.version}:rev:${triggerId.slice(0, 24)}`;
            const idemHash = createHash('sha256')
              .update(`paid-rev:${cohort.promoterUserId}:${cohort.model}:${cohort.version}:${triggerId}:pending`)
              .digest('hex')
              .slice(0, 48);
            const deltaPts = -Number(reclaimPending);
            await tx.execute(sql`
              insert into rewards_points_ledger
                (lot_id, user_id, delta_points, state, activity_code, source_ref, idempotency_key, valuation_microusd, rate_version, earned_at, cleared_at)
              values
                (${cohortLotId}, ${cohort.promoterUserId}, ${deltaPts}, 'reversed'::rewards_point_state, 'reward_points_reversal',
                 ${sourceRef}, ${`paid-rev-p:${idemHash}`}, ${(BigInt(deltaPts) * 10000n).toString()}::bigint, ${revRateVer}, ${now}, ${now})
            `);
          }

          if (reclaimAvailable > 0n) {
            const sourceRef = `paid-cohort:${cohort.model}:${cohort.version}:rev:${triggerId.slice(0, 24)}`;
            const idemHash = createHash('sha256')
              .update(`paid-rev:${cohort.promoterUserId}:${cohort.model}:${cohort.version}:${triggerId}:available`)
              .digest('hex')
              .slice(0, 48);
            const deltaPts = -Number(reclaimAvailable);
            await tx.execute(sql`
              insert into rewards_points_ledger
                (lot_id, user_id, delta_points, state, activity_code, source_ref, idempotency_key, valuation_microusd, rate_version, earned_at, cleared_at)
              values
                (${cohortLotId}, ${cohort.promoterUserId}, ${deltaPts}, 'reversed'::rewards_point_state, 'reward_points_reversal',
                 ${sourceRef}, ${`paid-rev-a:${idemHash}`}, ${(BigInt(deltaPts) * 10000n).toString()}::bigint, ${revRateVer}, ${now}, ${now})
            `);
          }

          if (fund) {
            let fundAvail = BigInt(fund.available_usd_cents);
            let fundAllocated = BigInt(fund.allocated_usd_cents);
            let fundPending = BigInt(fund.funded_pending_usd_cents);
            const fundCash = BigInt(fund.cash_balance_usd_cents);

            if (reclaimPending > 0n && fundPending >= reclaimPending) {
              fundPending -= reclaimPending;
              fundAvail += reclaimPending;
              await tx.execute(sql`
                update rewards_fund
                set available_usd_cents = ${fundAvail.toString()}::bigint,
                    funded_pending_usd_cents = ${fundPending.toString()}::bigint,
                    version = version + 1,
                    updated_at = ${now}
                where id = ${fund.id}
              `);
              await tx.execute(sql`
                insert into rewards_fund_ledger
                  (fund_id, type, amount_cents, from_bucket, to_bucket, cash_balance_after_cents, available_after_cents, allocated_after_cents, funded_pending_after_cents, source_ref, description, actor_id)
                values
                  (${fund.id}, 'release'::rewards_fund_ledger_type, ${reclaimPending.toString()}::bigint, 'funded_pending', 'available',
                   ${fundCash.toString()}::bigint, ${fundAvail.toString()}::bigint, ${fundAllocated.toString()}::bigint, ${fundPending.toString()}::bigint,
                   ${`paid-cohort:${cohort.model}:${cohort.version}:rel-p:${triggerId.slice(0, 24)}`},
                   'Release pending Rewards Fund backing for invalidated paid-loop points', ${cohort.latestInvalidActorId ?? cohort.latestActorId ?? null})
              `);
            }

            if (reclaimAvailable > 0n && fundAllocated >= reclaimAvailable) {
              fundAllocated -= reclaimAvailable;
              fundAvail += reclaimAvailable;
              await tx.execute(sql`
                update rewards_fund
                set available_usd_cents = ${fundAvail.toString()}::bigint,
                    allocated_usd_cents = ${fundAllocated.toString()}::bigint,
                    version = version + 1,
                    updated_at = ${now}
                where id = ${fund.id}
              `);
              await tx.execute(sql`
                insert into rewards_fund_ledger
                  (fund_id, type, amount_cents, from_bucket, to_bucket, cash_balance_after_cents, available_after_cents, allocated_after_cents, funded_pending_after_cents, source_ref, description, actor_id)
                values
                  (${fund.id}, 'release'::rewards_fund_ledger_type, ${reclaimAvailable.toString()}::bigint, 'allocated', 'available',
                   ${fundCash.toString()}::bigint, ${fundAvail.toString()}::bigint, ${fundAllocated.toString()}::bigint, ${fundPending.toString()}::bigint,
                   ${`paid-cohort:${cohort.model}:${cohort.version}:rel-a:${triggerId.slice(0, 24)}`},
                   'Release allocated Rewards Fund backing for invalidated paid-loop points', ${cohort.latestInvalidActorId ?? cohort.latestActorId ?? null})
              `);
            }
          }

          summary.reversedCohorts += 1;
          reversedTotal += totalReclaimed;
        }

        if (shortfall > 0n) {
          if (!cohort.latestIssueId || !cohort.latestInvalidAssessmentId || !cohort.latestInvalidActorId) {
            throw new Error(
              `Paid points shortfall of ${shortfall.toString()} for user ${cohort.promoterUserId} requires signed assessment and issue reference`,
            );
          }
          const recId = deterministicUuid(
            `paid-shortfall:${cohort.promoterUserId}:${cohort.model}:${cohort.version}:${cohort.latestIssueId}:${cohort.latestInvalidAssessmentId}`,
          );
          const recReqId = deterministicUuid(`paid-shortfall-req:${recId}`);
          const fingerprint = createHash('sha256')
            .update(
              JSON.stringify({
                userId: cohort.promoterUserId,
                model: cohort.model,
                version: cohort.version,
                issueId: cohort.latestIssueId,
                evidenceId: cohort.latestInvalidAssessmentId,
                shortfall: shortfall.toString(),
              }),
            )
            .digest('hex');
          const reason = `paid_points_redeemed_shortfall:${cohort.model}:${cohort.version}:shortfall=${shortfall.toString()}`;

          await tx.execute(sql`
            insert into reward_recovery_cases
              (id, request_id, fingerprint, issue_id, evidence_id, actor_id, reason)
            values
              (${recId}, ${recReqId}, ${fingerprint}, ${cohort.latestIssueId}, ${cohort.latestInvalidAssessmentId},
               ${cohort.latestInvalidActorId}, ${reason})
            on conflict (issue_id, evidence_id) do nothing
          `);

          summary.recoveryCasesCreated += 1;
          shortfallTotal += shortfall;
        }
      } else if (currentNet < desired && cohort.netLedgerCorrection < 0n) {
        const neededRestore = desired - currentNet;
        const maxRestorable = -cohort.netLedgerCorrection;
        const toRestore = neededRestore < maxRestorable ? neededRestore : maxRestorable;
        if (toRestore <= 0n) continue;

        if (!fund || BigInt(fund.available_usd_cents) < toRestore) {
          throw new Error(
            `Insufficient Rewards Fund available backing to restore ${toRestore.toString()} overturned points for user ${cohort.promoterUserId}`,
          );
        }

        const triggerId = cohort.latestAssessmentId ?? 'overturn-restore';
        const idemHash = createHash('sha256')
          .update(`paid-restore:${cohort.promoterUserId}:${cohort.model}:${cohort.version}:${triggerId}`)
          .digest('hex')
          .slice(0, 48);

        const [existingRestore] = await tx.execute<{ id: string }>(sql`
          select id from rewards_points_ledger where idempotency_key = ${`paid-res:${idemHash}`} limit 1
        `).then((r: any) => (r.rows ?? r));
        if (existingRestore) continue;

        const fundAvail = BigInt(fund.available_usd_cents) - toRestore;
        const fundAllocated = BigInt(fund.allocated_usd_cents) + toRestore;
        const fundPending = BigInt(fund.funded_pending_usd_cents);
        const fundCash = BigInt(fund.cash_balance_usd_cents);

        await tx.execute(sql`
          update rewards_fund
          set available_usd_cents = ${fundAvail.toString()}::bigint,
              allocated_usd_cents = ${fundAllocated.toString()}::bigint,
              version = version + 1,
              updated_at = ${now}
          where id = ${fund.id}
        `);

        const sourceRef = `paid-cohort:${cohort.model}:${cohort.version}:res:${triggerId.slice(0, 24)}`;
        await tx.execute(sql`
          insert into rewards_fund_ledger
            (fund_id, type, amount_cents, from_bucket, to_bucket, cash_balance_after_cents, available_after_cents, allocated_after_cents, funded_pending_after_cents, source_ref, description, actor_id)
          values
            (${fund.id}, 'allocate'::rewards_fund_ledger_type, ${toRestore.toString()}::bigint, 'available', 'allocated',
             ${fundCash.toString()}::bigint, ${fundAvail.toString()}::bigint, ${fundAllocated.toString()}::bigint, ${fundPending.toString()}::bigint,
             ${sourceRef}, 'Re-allocate Rewards Fund backing for overturned paid-loop points invalidation', ${cohort.latestActorId ?? null})
        `);

        if (!bal) {
          throw new Error(`Missing rewards_points_balances row for user ${cohort.promoterUserId}`);
        }
        await tx.execute(sql`
          update rewards_points_balances
          set available_points = available_points + ${Number(toRestore)},
              version = version + 1,
              updated_at = ${now}
          where id = ${bal.id}
        `);

        const revRateVer = rateVersionNumber(cohort.version);
        const cohortLotId = `paid-cohort:${cohort.model}:${cohort.version}:${cohort.promoterUserId.slice(0, 8)}`;
        const restorePts = Number(toRestore);
        await tx.execute(sql`
          insert into rewards_points_ledger
            (lot_id, user_id, delta_points, state, activity_code, source_ref, idempotency_key, valuation_microusd, rate_version, earned_at, cleared_at, expires_at)
          values
            (${cohortLotId}, ${cohort.promoterUserId}, ${restorePts}, 'available'::rewards_point_state, 'reward_points_restore',
             ${sourceRef}, ${`paid-res:${idemHash}`}, ${(toRestore * 10000n).toString()}::bigint, ${revRateVer}, ${now}, ${now}, ${new Date(now.getTime() + 365 * 86400000)})
        `);

        summary.restoredCohorts += 1;
        restoredTotal += toRestore;
      }
    }

    summary.reversedPoints = reversedTotal.toString();
    summary.shortfallPointsRecorded = shortfallTotal.toString();
    summary.restoredPoints = restoredTotal.toString();
    return summary;
  });
}
