import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';

const hour = 3_600_000;
const cadence = 6 * hour;
const levels = [
  { name: 'tier2_6h', minAge: 0, width: 72 },
  { name: 'tier3_15d', minAge: 15 * 24, width: 6 },
  { name: 'tier3_30d', minAge: 30 * 24, width: 6 },
] as const;

type Checkpoint = {
  bucket: number;
  cursorAt: string;
  cursorId: string;
  duplicates: number;
  frequencySignals: number;
  unassessed: number;
  samples?: { eventId: string; reasons: string[] }[];
};

export async function runClickAuditWindows(db: NodePgDatabase<typeof schema>, start: string, now = Date.now()) {
  const latest = Math.floor(now / cadence) * cadence;
  const first = Math.ceil(Date.parse(start) / cadence) * cadence;
  for (const level of levels) {
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${level.name}))`);
      const prior = await tx.execute<{ id: string; notes: string; status: string }>(sql`
        select id, notes, status from ads_deep_audit_runs
        where audit_level = ${level.name} and run_number like 'CPC-V1-%'
        order by run_number desc limit 1 for update
      `);
      const previous = prior.rows[0];
      const checkpoint = previous ? JSON.parse(previous.notes) as Checkpoint : undefined;
      const bucket = checkpoint
        ? checkpoint.bucket + (previous.status === 'completed' ? cadence : 0)
        : first;
      if (bucket > latest) return;
      const upper = new Date(bucket - level.minAge * hour).toISOString();
      const lower = new Date(bucket - (level.minAge + level.width) * hour).toISOString();
      const state: Checkpoint = previous?.status === 'running' && checkpoint ? checkpoint : {
        bucket, cursorAt: lower, cursorId: '00000000-0000-0000-0000-000000000000',
        duplicates: 0, frequencySignals: 0, unassessed: 0,
      };
      const runNumber = 'CPC-V1-' + level.name + '-' + new Date(bucket).toISOString();
      const events = await tx.execute<{
        id: string; at: string; duplicate: boolean; frequency: boolean; unassessed: boolean;
      }>(sql`
        with batch as (
          select e.id, e.created_at, e.serve_id from ads_interactions e
          where e.type = 'click' and e.created_at >= ${lower}::timestamptz
            and e.created_at < ${upper}::timestamptz
            and (e.created_at, e.id) > (${state.cursorAt}::timestamptz, ${state.cursorId}::uuid)
          order by e.created_at, e.id limit 50
        )
        select b.id, b.created_at::text as at,
          exists (select 1 from ads_interactions earlier where earlier.serve_id = b.serve_id
            and earlier.type = 'click' and earlier.is_valid and earlier.verification_version = 2
            and (earlier.created_at, earlier.id) < (b.created_at, b.id)) as duplicate,
          exists (select 1 from ads_serves prior
            join ads_settlement_claims claim on claim.serve_id = prior.id
            join ads_interactions click on click.id = claim.interaction_id
            where s.cpc_visitor_key is not null and prior.campaign_id = s.campaign_id
              and prior.cpc_visitor_key = s.cpc_visitor_key and prior.pricing_model = 'cpc'
              and prior.id <> s.id and click.created_at <= b.created_at
              and click.created_at > b.created_at - interval '2160 hours') as frequency,
          s.inventory_class = 'paid' and not exists (select 1 from ads_event_assessments a
            where a.event_id = b.id) as unassessed
        from batch b left join ads_serves s on s.id = b.serve_id
        order by b.created_at, b.id
      `);
      const samples = state.samples ?? (state.samples = []);
      for (const event of events.rows) {
        if (samples.length < 50) {
          const reasons = [];
          if (event.duplicate) reasons.push('SAME_SERVE_REPEAT');
          if (event.frequency) reasons.push('PRIOR_PAID_CPC_WITHIN_90_DAYS');
          if (event.unassessed) reasons.push('ASSESSMENT_MISSING');
          if (reasons.length) samples.push({ eventId: event.id, reasons });
        }
        state.cursorAt = event.at;
        state.cursorId = event.id;
        state.duplicates += Number(event.duplicate);
        state.frequencySignals += Number(event.frequency);
        state.unassessed += Number(event.unassessed === true);
      }
      const done = events.rows.length < 50;
      await tx.execute(sql`
        insert into ads_deep_audit_runs
          (run_number, audit_level, lookback_hours, total_interactions_analyzed, status, notes, completed_at)
        values (${runNumber}, ${level.name}, ${level.width}, ${events.rows.length},
          ${done ? 'completed' : 'running'}, ${JSON.stringify({ ...state, lower, upper, policy: 'signed-cpc-v1', mode: 'report-only' })},
          ${done ? sql`now()` : sql`null`})
        on conflict (run_number) do update set
          total_interactions_analyzed = ads_deep_audit_runs.total_interactions_analyzed + excluded.total_interactions_analyzed,
          status = excluded.status, notes = excluded.notes, completed_at = excluded.completed_at
      `);
    });
  }
}
