import { BadRequestException, Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { AdsRoles } from '../security/ads-staff-grants';
import { billedClick, observedClickRows } from './observed-clicks';
import { reportRange, REPORT_ZONE } from './report-range';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const outcomes = ['all', 'redirects', 'valid', 'rejected', 'missing', 'billed'] as const;
const pageSize = 25;

@AdsRoles('ads_admin', 'super_admin')
@Controller('admin/ads/click-audit')
export class ClickAuditController {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(@Query() filters: Record<string, string | undefined>) {
    const { campaign, website, slot, from, to, outcome = 'all', page = '1' } = filters;
    if ([campaign, website, slot].some(id => id !== undefined && (typeof id !== 'string' || !uuid.test(id))) ||
      [from, to].some(day => day !== undefined && typeof day !== 'string') ||
      !(outcomes as readonly string[]).includes(outcome) || typeof page !== 'string' ||
      !/^[1-9]\d{0,3}$/.test(page)) {
      throw new BadRequestException('Invalid click audit filters.');
    }
    const now = new Date();
    const today = reportRange(undefined, undefined, now).today;
    const range = reportRange(from, to ?? today, now);
    const rows = observedClickRows({
      campaign: campaign ? sql`${campaign}::uuid` : undefined,
      from: range.from + 'T00:00:00+01:00', to: range.until + 'T00:00:00+01:00',
    });
    const outcomeWhere = {
      all: sql`true`, redirects: sql`receipt_id is not null`, valid: sql`valid is true`,
      rejected: sql`valid is false`, missing: sql`receipt_id is not null and event_id is null`, billed: sql`billed`,
    }[outcome as typeof outcomes[number]];
    const result = await this.db.execute<{ counts: unknown; total: number; items: unknown[] }>(sql`
      with audit as (
        select click.*, ${billedClick} as billed
        from (${rows}) click
        where click.at <= ${now.toISOString()}::timestamptz
          ${website ? sql`and click.website_id = ${website}` : sql``}
          ${slot ? sql`and click.slot_id = ${slot}` : sql``}
      ), selected as (
        select * from audit where ${outcomeWhere}
      ), page_rows as (
        select click.id, click.at, click.receipt_id, click.event_id, click.serve_id,
          click.campaign_id, click.website_id, click.slot_id, click.valid, click.reason, click.billed,
          campaign.title as campaign, website.domain, slot.name as slot, s.request_id,
          r.state as reservation_state, r.release_reason, r.event_deadline, r.claim_event_id, r.settled_at,
          case when s.pricing_model = 'cpc' then
            case when s.cpc_visitor_key is null then 'unknown' else 'established' end
          end as visitor_history,
          claim.id as settlement_claim_id, debit.id as debit_id, debit.cents as billed_usd_cents,
          assessment.outcome as assessment,
          assessment.reason_codes as assessment_reasons,
          exists(select 1 from ads_evidence_records e where e.event_id = click.event_id) as has_journal
        from (select * from selected order by at desc, id desc limit ${pageSize} offset ${(Number(page) - 1) * pageSize}) click
        join ads_campaigns campaign on campaign.id = click.campaign_id
        left join ads_serves s on s.id = click.serve_id
        left join ads_promoter_websites website on website.id = click.website_id
        left join adstation_slots slot on slot.id = click.slot_id
        left join ads_opportunity_reservations r on r.id = s.opportunity_reservation_id
        left join ads_settlement_claims claim on claim.interaction_id = click.event_id and claim.serve_id = click.serve_id
        left join lateral (
          select t.id, item.billed_usd_cents::int as cents
          from ads_promoter_settlement_items item
          join billing_transactions t on t.reference = 'ads-spend-v3-' || item.batch_id::text
            and t.status = 'completed' and t.type = 'ads_spend' and t.provider = 'internal'
          where click.billed and item.batch_id = claim.batch_id and item.campaign_id = click.campaign_id
            and item.idempotency_key = 'ads-item:v3:' || click.event_id::text
            and item.billed_usd_cents > 0 and item.clicks_count > 0
          order by item.id, t.id limit 1
        ) debit on true
        left join lateral (
          select outcome, reason_codes from ads_event_assessments
          where event_id = click.event_id and campaign_id = click.campaign_id
          order by created_at desc, id desc limit 1
        ) assessment on true
      )
      select jsonb_build_object('all', count(*), 'redirects', count(*) filter (where receipt_id is not null),
        'valid', count(distinct event_id) filter (where valid is true),
        'rejected', count(distinct event_id) filter (where valid is false),
        'missing', count(*) filter (where receipt_id is not null and event_id is null),
        'billed', count(distinct event_id) filter (where billed)) as counts,
        (select count(*)::int from selected) as total,
        (select coalesce(jsonb_agg(to_jsonb(page_rows) order by at desc, id desc), '[]'::jsonb) from page_rows) as items
      from audit
    `);
    return { status: 'success', data: { ...result.rows[0], page: Number(page), pageSize,
      from: range.from, to: range.to, timezone: REPORT_ZONE, updatedAt: now.toISOString() } };
  }
}
