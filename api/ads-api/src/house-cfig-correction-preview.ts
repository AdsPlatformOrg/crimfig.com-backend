import { createHash } from 'crypto';
import { validEvidenceSignature } from '@crimfig/shared';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { verifyAssessmentRecord } from './event-cash-rebate-reconciliation';
import { allocateDay, type HousePolicy, type RewardCandidate, utcWindow } from './modules/cfig/cfig-allocation';
import { parsePolicy } from './modules/cfig/cfig-policy';

export interface HouseCfigCorrectionItem {
  eventId: string;
  pendingMicroCfig: string;
  availableMicroCfig: string;
  convertedMicroCfig: string;
}

export interface HouseCfigReconciliationSummary {
  daysReplayed: number;
  eventsEvaluated: number;
  invalidatedEvents: number;
  invalidatedMicroCfig: string;
  restoredEvents: number;
  restoredMicroCfig: string;
  reclaimedCapMicroCfig: string;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function verifyHouseReview(
  row: {
    id: string;
    event_id: string;
    outcome: string;
    payload: any;
    key_id: string;
    record_hash: string;
  },
  env = process.env,
): boolean {
  if (
    !row.payload ||
    row.payload.eventId !== row.event_id ||
    row.payload.outcome !== row.outcome
  ) {
    return false;
  }
  return validEvidenceSignature({ ...row.payload, keyId: row.key_id }, row.record_hash, env);
}

export async function houseCfigCorrectionPreview(
  db: NodePgDatabase<typeof schema>,
  window: { lower: string; upper: string },
  env = process.env,
): Promise<HouseCfigCorrectionItem[]> {
  const result = await db.execute<{
    event_id: string;
    review_id: string;
    outcome: string;
    payload: { eventId?: string; outcome?: string };
    key_id: string;
    record_hash: string;
    pending: string;
    available: string;
    converted: string;
  }>(sql`
    with affected as (
      select allocation.event_id, latest.id as review_id, latest.outcome, latest.payload, latest.key_id, latest.record_hash, latest.created_at as review_created_at
      from cfig_allocations allocation
      join ads_interactions event on event.id = allocation.event_id
      join ads_serves serve on serve.id = event.serve_id and serve.inventory_class = 'house'
      join lateral (
        select review.id, review.outcome, review.payload, review.key_id, review.record_hash, review.created_at
        from cfig_event_reviews review
        where review.event_id = event.id
        order by review.created_at desc, review.id desc
        limit 1
      ) latest on latest.outcome = 'invalid'
      where allocation.allocated > 0
        and (
          (event.created_at >= ${window.lower}::timestamptz and event.created_at < ${window.upper}::timestamptz)
          or (latest.created_at >= ${window.lower}::timestamptz and latest.created_at <= ${window.upper}::timestamptz)
        )
      order by event.created_at, event.id limit 50
    )
    select affected.event_id, affected.review_id, affected.outcome, affected.payload, affected.key_id, affected.record_hash,
      coalesce(sum(ledger.pending_delta), 0)::text as pending,
      coalesce(sum(ledger.available_delta), 0)::text as available,
      coalesce(sum(ledger.converted_delta), 0)::text as converted
    from affected
    join cfig_ledger ledger on ledger.event_id = affected.event_id
    group by affected.event_id, affected.review_id, affected.outcome, affected.payload, affected.key_id, affected.record_hash, affected.review_created_at
    having coalesce(sum(ledger.pending_delta), 0) > 0
      or coalesce(sum(ledger.available_delta), 0) > 0
      or (
        coalesce(sum(ledger.converted_delta), 0) > 0
        and not exists (
          select 1 from cfig_ledger correction
          where correction.event_id = affected.event_id
            and correction.kind = 'invalidate'
            and correction.created_at >= affected.review_created_at
        )
      )
    order by affected.event_id
  `);
  return result.rows
    .filter((row) =>
      verifyHouseReview(
        {
          id: row.review_id,
          event_id: row.event_id,
          outcome: row.outcome,
          payload: row.payload,
          key_id: row.key_id,
          record_hash: row.record_hash,
        },
        env,
      ),
    )
    .map((row) => ({
      eventId: row.event_id,
      pendingMicroCfig: row.pending,
      availableMicroCfig: row.available,
      convertedMicroCfig: row.converted,
    }));
}

/**
 * Replays finalized House-ad days containing post-click review or assessment changes
 * under the day's original daily, monthly, promoter, and global caps.
 * - Rejects any tampered review or assessment signature (fail-closed, zero writes).
 * - Invalidates unsupported pending/available virtual $CFIG balances.
 * - Restores overturned events and reallocates freed cap headroom to eligible sibling
 *   events on the same finalized day using append-only 'invalidate' and 'restore' entries.
 */
export async function reconcileHouseCfigCorrections(
  db: NodePgDatabase<typeof schema>,
  window: { lower: string; upper: string },
  env = process.env,
): Promise<HouseCfigReconciliationSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cfig:global-allocation', 0))`);

    const hasAssessmentsRes = await tx.execute<{ tbl: string | null }>(
      sql`select to_regclass('public.ads_event_assessments')::text as tbl`,
    );
    const hasAssessments = Boolean(((hasAssessmentsRes as any).rows ?? hasAssessmentsRes)[0]?.tbl);

    const daysRes = await tx.execute<{ day: string }>(sql`
      select distinct to_char(allocation.day, 'YYYY-MM-DD') as day
      from cfig_allocations allocation
      join ads_interactions event on event.id = allocation.event_id
      left join lateral (
        select created_at from cfig_event_reviews r where r.event_id = allocation.event_id order by r.created_at desc, r.id desc limit 1
      ) latest_rev on true
      ${hasAssessments ? sql`
        left join lateral (
          select created_at from ads_event_assessments a where a.event_id = allocation.event_id order by a.created_at desc, a.id desc limit 1
        ) latest_ass on true
      ` : sql``}
      where (event.created_at >= ${window.lower}::timestamptz and event.created_at <= ${window.upper}::timestamptz)
         or (latest_rev.created_at >= ${window.lower}::timestamptz and latest_rev.created_at <= ${window.upper}::timestamptz)
         ${hasAssessments ? sql`or (latest_ass.created_at >= ${window.lower}::timestamptz and latest_ass.created_at <= ${window.upper}::timestamptz)` : sql``}
      order by day asc
    `);

    const dayRows = ((daysRes as any).rows ?? daysRes) as Array<{ day: string }>;

    const summary: HouseCfigReconciliationSummary = {
      daysReplayed: 0,
      eventsEvaluated: 0,
      invalidatedEvents: 0,
      invalidatedMicroCfig: '0',
      restoredEvents: 0,
      restoredMicroCfig: '0',
      reclaimedCapMicroCfig: '0',
    };

    let invalidatedTotal = 0n;
    let restoredTotal = 0n;
    let reclaimedTotal = 0n;

    for (const { day } of dayRows) {
      const finRes = await tx.execute<{
        day: string;
        actor_id: string;
        snapshot: any;
        created_at: string;
      }>(sql`
        select to_char(day, 'YYYY-MM-DD') as day, actor_id, snapshot, created_at
        from cfig_finalizations
        where day = ${day}::date
        limit 1
      `);
      const fin = ((finRes as any).rows ?? finRes)[0];
      if (!fin) continue;

      const month = day.slice(0, 7);
      const budgetRes = await tx.execute<{
        policy_id: string;
        snapshot: any;
      }>(sql`
        select policy_id, snapshot from cfig_period_budgets where month = ${month} limit 1
      `);
      const budget = ((budgetRes as any).rows ?? budgetRes)[0];

      const policyId: string | undefined = fin.snapshot?.policyId ?? budget?.policy_id;
      let housePolicy: HousePolicy | null = null;
      if (fin.snapshot?.policy) {
        housePolicy = parsePolicy(fin.snapshot.policy).houseRewards;
      } else if (budget?.snapshot) {
        housePolicy = budget.snapshot as HousePolicy;
      } else if (policyId) {
        const polRes = await tx.execute<{ terms: any }>(
          sql`select terms from cfig_policies where id = ${policyId} limit 1`,
        );
        const polRow = ((polRes as any).rows ?? polRes)[0];
        if (polRow?.terms) housePolicy = parsePolicy(polRow.terms).houseRewards;
      }
      if (!housePolicy || !policyId) {
        throw new Error(`Missing CFIG policy snapshot for finalized day ${day}`);
      }

      const dayEventsRes = await tx.execute<{
        event_id: string;
        serve_id: string;
        promoter_id: string;
        policy_id: string | null;
        metric: string;
        original_outcome: string;
        entitled: string;
        original_allocated: string;
        source_snapshot: any;
        served_at: string;
        event_created_at: string;
        latest_review: any | null;
        earliest_eligible_review_at: string | null;
        latest_assessment: any | null;
      }>(sql`
        select
          ca.event_id,
          ca.serve_id,
          ca.promoter_id,
          ca.policy_id,
          ca.metric,
          ca.outcome as original_outcome,
          ca.entitled::text as entitled,
          ca.allocated::text as original_allocated,
          ca.source_snapshot,
          to_char(s.served_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as served_at,
          e.created_at as event_created_at,
          row_to_json(latest_rev) as latest_review,
          (
            select min(er.created_at)
            from cfig_event_reviews er
            where er.event_id = ca.event_id and er.outcome = 'eligible'
          ) as earliest_eligible_review_at,
          ${hasAssessments ? sql`row_to_json(latest_ass)` : sql`null::json`} as latest_assessment
        from cfig_allocations ca
        join ads_interactions e on e.id = ca.event_id
        join ads_serves s on s.id = ca.serve_id
        left join lateral (
          select id, event_id, outcome, actor_id, reason, payload, key_id, record_hash, created_at
          from cfig_event_reviews r
          where r.event_id = ca.event_id
          order by r.created_at desc, r.id desc
          limit 1
        ) latest_rev on true
        ${hasAssessments ? sql`
          left join lateral (
            select id, event_id, campaign_id, request_id, actor_id, policy_version, outcome, reason_codes, features, supersedes_id, key_id, record_hash, created_at
            from ads_event_assessments a
            where a.event_id = ca.event_id
            order by a.created_at desc, a.id desc
            limit 1
          ) latest_ass on true
        ` : sql``}
        where ca.day = ${day}::date
        order by s.served_at asc, s.id asc, ca.event_id asc
      `);

      const dayEvents = ((dayEventsRes as any).rows ?? dayEventsRes) as Array<{
        event_id: string;
        serve_id: string;
        promoter_id: string;
        policy_id: string | null;
        metric: string;
        original_outcome: string;
        entitled: string;
        original_allocated: string;
        source_snapshot: any;
        served_at: string;
        event_created_at: string;
        latest_review: any | null;
        earliest_eligible_review_at: string | null;
        latest_assessment: any | null;
      }>;
      if (!dayEvents.length) continue;

      const dayWindow = utcWindow(day);
      const fallbackValidTime = new Date(dayWindow.cutoff.getTime() - 1000);

      // Verify all review and assessment signatures BEFORE building replay candidates.
      const candidates: RewardCandidate[] = [];
      const rowByEventId = new Map<string, (typeof dayEvents)[number]>();

      for (const ev of dayEvents) {
        rowByEventId.set(ev.event_id, ev);

        if (ev.latest_review) {
          const ok = verifyHouseReview(
            {
              id: ev.latest_review.id,
              event_id: ev.latest_review.event_id,
              outcome: ev.latest_review.outcome,
              payload: ev.latest_review.payload,
              key_id: ev.latest_review.key_id,
              record_hash: ev.latest_review.record_hash,
            },
            env,
          );
          if (!ok) {
            throw new Error(`Invalid CFIG review evidence signature for event ${ev.event_id} (${ev.latest_review.id})`);
          }
        }

        if (ev.latest_assessment) {
          const a = ev.latest_assessment;
          const ok = verifyAssessmentRecord(
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
          if (!ok) {
            throw new Error(`Invalid assessment evidence signature for house event ${ev.event_id} (${a.id})`);
          }
        }

        const snap = ev.source_snapshot && typeof ev.source_snapshot === 'object' ? ev.source_snapshot : {};
        const servedAtIso =
          typeof snap.servedAt === 'string' && snap.servedAt.startsWith(day + 'T')
            ? snap.servedAt
            : new Date(ev.served_at).toISOString();
        const receivedAtRaw = snap.receivedAt ? new Date(snap.receivedAt) : new Date(ev.event_created_at);
        const receivedAt = receivedAtRaw < dayWindow.cutoff ? receivedAtRaw : fallbackValidTime;

        const permanentlyExcluded =
          typeof snap.exclusion === 'string' &&
          ['TESTING_EXCLUDED', 'HISTORICAL_STATUS_UNKNOWN', 'POLICY_INACTIVE', 'WEBSITE_NOT_APPROVED', 'LATE_EXCLUDED', 'DUPLICATE_SOURCE', 'UNSUPPORTED_METRIC'].includes(
            snap.exclusion,
          );

        const isInvalidNow =
          ev.latest_review?.outcome === 'invalid' || ev.latest_assessment?.outcome === 'invalid';

        let eligible: boolean;
        let exclusion: string | undefined;
        let validatedAt: Date | null = null;

        if (isInvalidNow) {
          eligible = false;
          exclusion = 'POST_CLICK_INVALIDATED';
        } else if (permanentlyExcluded) {
          eligible = false;
          exclusion = snap.exclusion;
        } else if (ev.latest_review?.outcome === 'eligible' || Boolean(snap.eligible) || BigInt(ev.entitled) > 0n) {
          eligible = true;
          const snapValidated = snap.validatedAt ? new Date(snap.validatedAt) : null;
          const earliestRev = ev.earliest_eligible_review_at ? new Date(ev.earliest_eligible_review_at) : null;
          if (snapValidated && Number.isFinite(+snapValidated) && snapValidated < dayWindow.cutoff) {
            validatedAt = snapValidated;
          } else if (earliestRev && Number.isFinite(+earliestRev) && earliestRev < dayWindow.cutoff) {
            validatedAt = earliestRev;
          } else {
            validatedAt = fallbackValidTime;
          }
        } else {
          eligible = Boolean(snap.eligible);
          exclusion = snap.exclusion ?? 'INELIGIBLE';
        }

        candidates.push({
          eventId: ev.event_id,
          serveId: ev.serve_id,
          promoterId: ev.promoter_id,
          servedAt: servedAtIso,
          receivedAt,
          validatedAt,
          metric: typeof snap.metric === 'string' ? snap.metric : ev.metric,
          eligible,
          exclusion,
          policyId: ev.policy_id ?? policyId,
        });
      }

      // Compute prior usage BEFORE this day from live ledger balances so invalidated
      // earlier days don't crowd out eligible headroom while preserving active caps.
      const priorPromoterRes = await tx.execute<{ promoter_id: string; total: string }>(sql`
        select ca.promoter_id, coalesce(sum(cl.pending_delta + cl.available_delta + cl.converted_delta), 0)::text as total
        from cfig_allocations ca
        join cfig_ledger cl on cl.event_id = ca.event_id
        where to_char(ca.day, 'YYYY-MM') = ${month}
          and ca.day <> ${day}::date
        group by ca.promoter_id
      `);
      const priorPromoters = new Map<string, bigint>();
      let priorGlobal = 0n;
      for (const r of ((priorPromoterRes as any).rows ?? priorPromoterRes) as Array<{ promoter_id: string; total: string }>) {
        const val = BigInt(r.total);
        const clamped = val > 0n ? val : 0n;
        priorPromoters.set(r.promoter_id, clamped);
        priorGlobal += clamped;
      }

      const priorOutstandingRes = await tx.execute<{ outstanding: string }>(sql`
        select coalesce(sum(cl.pending_delta + cl.available_delta), 0)::text as outstanding
        from cfig_ledger cl
        where not exists (
          select 1 from cfig_allocations ca
          where ca.event_id = cl.event_id and ca.day = ${day}::date
        )
      `);
      const rawOutstanding = BigInt(((priorOutstandingRes as any).rows ?? priorOutstandingRes)[0]?.outstanding ?? '0');
      const priorOutstanding = rawOutstanding > 0n ? rawOutstanding : 0n;

      const replayTime = new Date(Math.max(Date.parse(fin.created_at), dayWindow.cutoff.getTime()));
      const replayed = allocateDay(
        day,
        candidates,
        housePolicy,
        {
          promoters: priorPromoters,
          global: priorGlobal,
          outstanding: priorOutstanding,
        },
        replayTime,
      );

      // Check current cfig_ledger balances for every event on this day.
      const ledgerRes = await tx.execute<{
        event_id: string;
        pending: string;
        available: string;
        converted: string;
        invalid: string;
        has_clear: boolean;
      }>(sql`
        select
          ca.event_id,
          coalesce(sum(cl.pending_delta), 0)::text as pending,
          coalesce(sum(cl.available_delta), 0)::text as available,
          coalesce(sum(cl.converted_delta), 0)::text as converted,
          coalesce(sum(cl.invalid_delta), 0)::text as invalid,
          bool_or(cl.kind = 'clear') as has_clear
        from cfig_allocations ca
        left join cfig_ledger cl on cl.event_id = ca.event_id
        where ca.day = ${day}::date
        group by ca.event_id
      `);
      const ledgerByEvent = new Map(
        (((ledgerRes as any).rows ?? ledgerRes) as Array<{
          event_id: string;
          pending: string;
          available: string;
          converted: string;
          invalid: string;
          has_clear: boolean | null;
        }>).map((r) => [
          r.event_id,
          {
            pending: BigInt(r.pending),
            available: BigInt(r.available),
            converted: BigInt(r.converted),
            invalid: BigInt(r.invalid),
            hasClear: Boolean(r.has_clear),
          },
        ]),
      );

      const triggerFingerprint = candidates
        .map((c) => {
          const ev = rowByEventId.get(c.eventId)!;
          return `${c.eventId}:${ev.latest_review?.id ?? 'none'}:${ev.latest_assessment?.id ?? 'none'}`;
        })
        .join('|');
      const dayTriggerHash = createHash('sha256').update(triggerFingerprint).digest('hex').slice(0, 16);

      for (const alloc of replayed.allocations) {
        summary.eventsEvaluated += 1;
        const ev = rowByEventId.get(alloc.candidate.eventId)!;
        const bal = ledgerByEvent.get(alloc.candidate.eventId) ?? {
          pending: 0n,
          available: 0n,
          converted: 0n,
          invalid: 0n,
          hasClear: false,
        };
        const currentLive = bal.pending + bal.available + bal.converted;
        const targetAllocated = alloc.allocated;
        const eventPolicyId = ev.policy_id ?? policyId;
        const actorId: string = ev.latest_review?.actor_id ?? ev.latest_assessment?.actor_id ?? fin.actor_id;

        if (!alloc.candidate.eligible && (bal.pending > 0n || bal.available > 0n)) {
          const invalidAmt = bal.pending + bal.available;
          const pendingDelta = -bal.pending;
          const availableDelta = -bal.available;
          const triggerId = ev.latest_review?.id ?? ev.latest_assessment?.id ?? dayTriggerHash;
          const reqId = deterministicUuid(
            `cfig-inv:${day}:${ev.event_id}:${triggerId}:${pendingDelta}:${availableDelta}:${invalidAmt}`,
          );
          const fp = createHash('sha256')
            .update(`invalidate:${ev.event_id}:${reqId}:${invalidAmt}`)
            .digest('hex');

          await tx.execute(sql`
            insert into cfig_ledger
              (id, request_id, fingerprint, event_id, promoter_id, policy_id, kind, pending_delta, available_delta, converted_delta, invalid_delta, actor_id, reason)
            values
              (${deterministicUuid(`cfig-row:${reqId}`)}, ${reqId}, ${fp}, ${ev.event_id}, ${ev.promoter_id}, ${eventPolicyId}, 'invalidate',
               ${pendingDelta.toString()}::bigint, ${availableDelta.toString()}::bigint, 0, ${invalidAmt.toString()}::bigint,
               ${actorId}, ${`post_click_invalidated:${String(triggerId).slice(0, 64)}`})
            on conflict (request_id) do nothing
          `);

          summary.invalidatedEvents += 1;
          invalidatedTotal += invalidAmt;
        } else if (alloc.candidate.eligible && targetAllocated > currentLive) {
          const gain = targetAllocated - currentLive;
          const restoreToAvailable = bal.hasClear || bal.available > 0n;
          const pendingDelta = restoreToAvailable ? 0n : gain;
          const availableDelta = restoreToAvailable ? gain : 0n;
          const invalidDelta = bal.invalid > 0n ? -(bal.invalid < gain ? bal.invalid : gain) : 0n;
          const triggerId = ev.latest_review?.id ?? ev.latest_assessment?.id ?? dayTriggerHash;
          const reqId = deterministicUuid(
            `cfig-res:${day}:${ev.event_id}:${triggerId}:${pendingDelta}:${availableDelta}:${invalidDelta}`,
          );
          const fp = createHash('sha256')
            .update(`restore:${ev.event_id}:${reqId}:${gain}`)
            .digest('hex');

          await tx.execute(sql`
            insert into cfig_ledger
              (id, request_id, fingerprint, event_id, promoter_id, policy_id, kind, pending_delta, available_delta, converted_delta, invalid_delta, actor_id, reason)
            values
              (${deterministicUuid(`cfig-row:${reqId}`)}, ${reqId}, ${fp}, ${ev.event_id}, ${ev.promoter_id}, ${eventPolicyId}, 'restore',
               ${pendingDelta.toString()}::bigint, ${availableDelta.toString()}::bigint, 0, ${invalidDelta.toString()}::bigint,
               ${actorId}, ${`post_click_cohort_restore:${day}:${String(triggerId).slice(0, 40)}`})
            on conflict (request_id) do nothing
          `);

          summary.restoredEvents += 1;
          restoredTotal += gain;
        } else if (alloc.candidate.eligible && targetAllocated < currentLive) {
          const excess = currentLive - targetAllocated;
          const unconverted = bal.pending + bal.available;
          const reclaim = excess < unconverted ? excess : unconverted;
          if (reclaim <= 0n) continue;

          const fromPending = reclaim < bal.pending ? reclaim : bal.pending;
          const fromAvailable = reclaim - fromPending;
          const pendingDelta = -fromPending;
          const availableDelta = -fromAvailable;
          const reqId = deterministicUuid(
            `cfig-cap:${day}:${ev.event_id}:${dayTriggerHash}:${pendingDelta}:${availableDelta}`,
          );
          const fp = createHash('sha256')
            .update(`cap_reclaim:${ev.event_id}:${reqId}:${reclaim}`)
            .digest('hex');

          await tx.execute(sql`
            insert into cfig_ledger
              (id, request_id, fingerprint, event_id, promoter_id, policy_id, kind, pending_delta, available_delta, converted_delta, invalid_delta, actor_id, reason)
            values
              (${deterministicUuid(`cfig-row:${reqId}`)}, ${reqId}, ${fp}, ${ev.event_id}, ${ev.promoter_id}, ${eventPolicyId}, 'restore',
               ${pendingDelta.toString()}::bigint, ${availableDelta.toString()}::bigint, 0, 0,
               ${actorId}, ${`post_click_cap_reconcile:${day}:${dayTriggerHash}`})
            on conflict (request_id) do nothing
          `);

          reclaimedTotal += reclaim;
        }
      }

      summary.daysReplayed += 1;
    }

    summary.invalidatedMicroCfig = invalidatedTotal.toString();
    summary.restoredMicroCfig = restoredTotal.toString();
    summary.reclaimedCapMicroCfig = reclaimedTotal.toString();
    return summary;
  });
}
