import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { AdsRoles } from '../security/ads-staff-grants';
import { reportRange, REPORT_ZONE } from '../analytics/report-range';

function pageOffset(value = '1') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value)) throw new BadRequestException('Invalid page.');
  return (Number(value) - 1) * 25;
}
function dateRange(from?: string, to?: string) {
  if ([from, to].some(value => value !== undefined && typeof value !== 'string')) throw new BadRequestException('Invalid report dates.');
  return reportRange(from, to, new Date());
}

@Controller('admin/reports')
export class AdminReportsController {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {}

  @Get('overview')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('super_admin','ads_admin','ads_finance','ads_support','report_auditor','report_contact_reveal')
  overview() {
    return { status: 'success', data: { sources: [
      { name: 'Delivery & Traffic Quality', source: 'Ads delivery receipts', basis: 'Served date, Africa/Lagos' },
      { name: 'Finance & Reconciliation', source: 'Billing transactions', basis: 'Posted date and current clearance status, USD cents' },
      { name: 'Report Access Audit', source: 'Append-only report access ledger', basis: 'UTC access time' },
    ] } };
  }

  @Get('delivery')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('super_admin','ads_admin')
  async delivery(@Query('from') from?: string, @Query('to') to?: string) {
    const range = dateRange(from, to);
    const result = await this.db.execute(sql`SELECT
      count(*) FILTER (WHERE inventory_class='paid' AND delivery_mode='normal')::text AS paid_serves,
      count(*) FILTER (WHERE inventory_class='house' AND delivery_mode='normal')::text AS promo_serves,
      count(*) FILTER (WHERE inventory_class='bonus_promo' AND delivery_mode='normal')::text AS bonus_promo_serves,
      count(*) FILTER (WHERE inventory_class='paid' AND delivery_mode='normal' AND financial_eligibility='quarantined')::text AS quarantined_serves
      FROM ads_serves WHERE served_at >= (${range.from}::date::timestamp AT TIME ZONE ${REPORT_ZONE})
        AND served_at < (${range.until}::date::timestamp AT TIME ZONE ${REPORT_ZONE})`);
    return { status: 'success', data: { ...range, timezone: REPORT_ZONE, updatedAt: new Date().toISOString(), metrics: result.rows[0] } };
  }

  @Get('finance')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('super_admin','ads_finance')
  async finance(@Query('from') from?: string, @Query('to') to?: string) {
    const range = dateRange(from, to);
    const startTs = sql`(${range.from}::date::timestamp AT TIME ZONE ${REPORT_ZONE})`;
    const endTs = sql`(${range.until}::date::timestamp AT TIME ZONE ${REPORT_ZONE})`;
    const result = await this.db.execute(sql`SELECT
      coalesce(sum(amount_usd_cents) FILTER (WHERE type='ads_spend' AND status='completed'),0)::text AS posted_ad_spend_cents,
      coalesce(sum(amount_usd_cents) FILTER (WHERE type='ads_earning' AND status='pending'),0)::text AS pending_earnings_cents,
      coalesce(sum(amount_usd_cents) FILTER (WHERE type='ads_earning' AND status='completed' AND coalesce((metadata::jsonb)->>'kind','') <> 'bonus_promo_earning'),0)::text AS cleared_earnings_cents,
      coalesce(sum(amount_usd_cents) FILTER (WHERE type='ads_earning' AND status='completed' AND (metadata::jsonb)->>'kind' = 'bonus_promo_earning'),0)::text AS bonus_promo_cleared_cents,
      coalesce((SELECT sum(promoter_earnings_microusd) FROM bonus_promo_impressions WHERE clearance_status='pending' AND created_at >= ${startTs} AND created_at < ${endTs}),0)::text AS bonus_promo_pending_microusd,
      coalesce((SELECT sum(amount_cents) FROM platform_reserve_transfers WHERE from_reserve IN ('platform_operating_reserve','promotional_ad_reserve','rewards_fund_available','cfig_conversion_reserve') AND created_at >= ${startTs} AND created_at < ${endTs}),0)::text AS inter_reserve_transfers_cents,
      coalesce((SELECT available_cents FROM cfig_conversion_reserve WHERE currency='USD' LIMIT 1),0)::text AS cfig_reserve_available_cents
      FROM billing_transactions WHERE created_at >= ${startTs}
        AND created_at < ${endTs}`);
    return { status: 'success', data: { ...range, timezone: REPORT_ZONE, updatedAt: new Date().toISOString(), metrics: result.rows[0],
      basis: 'Posted Billing transaction amounts by creation date and current status.' } };
  }

  @Get('contacts')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('ads_support','ads_admin','report_auditor')
  async contacts(@Query('page') page?: string) {
    const offset = pageOffset(page);
    const result = await this.db.execute(sql`SELECT id,
      CASE WHEN email IS NULL THEN NULL ELSE left(email,1)||'***@'||split_part(email,'@',2) END AS email,
      CASE WHEN phone IS NULL THEN NULL ELSE '***'||right(phone,2) END AS phone,
      email IS NOT NULL AS has_email, phone IS NOT NULL AS has_phone
      FROM users WHERE status <> 'DELETED' ORDER BY id LIMIT 25 OFFSET ${offset}`);
    return { status: 'success', data: result.rows };
  }

  @Post('contacts/:userId/reveal')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('report_contact_reveal')
  async reveal(@Param('userId') userId: string, @Body() body: { field?: string; reason?: string }) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(userId) || !body ||
      !['email','phone'].includes(body.field ?? '') || !['account_support','payment_investigation','policy_review'].includes(body.reason ?? '') ||
      Object.keys(body).some(key => key !== 'field' && key !== 'reason')) throw new BadRequestException('Choose a contact field and investigation reason.');
    const result = await this.db.execute<{ value: string | null }>(sql`SELECT ${sql.identifier(body.field!)} AS value FROM users WHERE id=${userId}::uuid AND status <> 'DELETED'`);
    if (!result.rows[0]?.value) throw new NotFoundException('Contact not found.');
    return { status: 'success', data: { field: body.field, value: result.rows[0].value, remaskAfterSeconds: 30 } };
  }

  @Get('access')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('report_auditor')
  async access(@Query('page') page?: string) {
    const offset = pageOffset(page);
    const result = await this.db.execute(sql`SELECT position::text,actor_id,actor_roles,action,outcome,scope,correlation_id,reason_code,created_at,previous_hash,entry_hash
      FROM report_access_audit ORDER BY position DESC LIMIT 25 OFFSET ${offset}`);
    return { status: 'success', data: result.rows };
  }

  @Get('access/integrity')
  @Header('Cache-Control', 'private, no-store')
  @AdsRoles('report_auditor')
  async integrity() {
    const result = await this.db.execute(sql`WITH entries AS (SELECT *,lag(entry_hash) OVER (ORDER BY position) AS expected_previous
      FROM report_access_audit)
      SELECT count(*)::text AS entries, count(*) FILTER (WHERE previous_hash IS DISTINCT FROM expected_previous OR
        entry_hash <> encode(sha256(convert_to(jsonb_build_array(position,actor_id,actor_roles,action,outcome,scope,
        correlation_id,reason_code,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),previous_hash)::text,'UTF8')),'hex'))::text AS invalid_entries
      FROM entries`);
    return { status: 'success', data: result.rows[0] };
  }
}
