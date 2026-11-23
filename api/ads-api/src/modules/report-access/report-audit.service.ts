import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { AdsStaffGrants } from '../security/ads-staff-grants';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function reportAction(path: string): string | null {
  path = path.toLowerCase();
  if (/^\/api\/v1\/reports\/daily\/?$/.test(path)) return 'report.daily';
  if (/^\/api\/v1\/admin\/ads\/click-audit\/?$/.test(path)) return 'report.click-audit';
  if (/^\/api\/v1\/admin\/reports(?:\/|$)/.test(path)) return 'report.admin';
  return null;
}

/** Only allowlisted, validated scope facts enter the audit ledger. */
export function reportScope(request: any) {
  const scope: Record<string, string> = {};
  for (const field of ['from','to']) {
    const value = request.query?.[field];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) scope[field] = value;
  }
  for (const field of ['campaign','website','slot']) {
    const value = request.query?.[field];
    if (typeof value === 'string' && uuid.test(value)) scope[field] = value;
  }
  const role = request.query?.role;
  if (role === 'advertiser' || role === 'promoter') scope.role = role;
  const target = request.params?.userId;
  if (typeof target === 'string' && uuid.test(target)) scope.target = target;
  const path = String(request.path ?? '').split('?')[0].toLowerCase().replace(/\/+$/, '');
  if (path.endsWith('/reveal')) scope.operation = 'contact_reveal';
  else if (path.endsWith('/contacts')) scope.operation = 'masked_contacts';
  else if (path.endsWith('/access')) scope.operation = 'access_audit';
  else if (path.endsWith('/access/integrity')) scope.operation = 'verify_audit_integrity';
  else if (path.endsWith('/finance')) scope.operation = 'finance';
  else if (path.endsWith('/delivery')) scope.operation = 'delivery';
  else if (path.endsWith('/overview')) scope.operation = 'overview';
  else scope.operation = 'view';
  const field = request.body?.field;
  if (field === 'email' || field === 'phone') scope.field = field;
  return scope;
}

@Injectable()
export class ReportAuditService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>, private readonly grants: AdsStaffGrants) {}

  async record(request: any, outcome: 'allowed' | 'denied' | 'failed', reasonCode?: string) {
    const action = reportAction(String(request.path ?? '').split('?')[0]);
    if (!action) return;
    const actor = typeof request.user?.sub === 'string' && uuid.test(request.user.sub) ? request.user.sub : null;
    const roles = actor ? [...await this.grants.rolesFor(actor)] : [];
    const correlation = request.reportCorrelationId ??
      (typeof request.correlationId === 'string' && uuid.test(request.correlationId) ? request.correlationId : randomUUID());
    request.reportCorrelationId = correlation;
    const scope = reportScope(request);
    try {
      await this.db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        await tx.execute(sql`set local statement_timeout = '8s'`);
        await tx.execute(sql`INSERT INTO report_access_audit(actor_id,actor_roles,action,outcome,scope,correlation_id,reason_code)
          VALUES (${actor}::uuid,${JSON.stringify(roles)}::jsonb,${action},${outcome},${JSON.stringify(scope)}::jsonb,${correlation}::uuid,${reasonCode ?? null})`);
        if (outcome === 'denied' || scope.operation === 'contact_reveal') {
          const kind = outcome === 'denied' ? 'repeated_denials' : 'reveal_burst';
          const count = await tx.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM report_access_audit
            WHERE actor_id IS NOT DISTINCT FROM ${actor}::uuid AND created_at >= now()-interval '10 minutes'
              AND ${outcome === 'denied' ? sql`outcome='denied'` : sql`scope->>'operation'='contact_reveal' AND outcome='allowed'`}`);
          if (Number(count.rows[0]?.count) >= (outcome === 'denied' ? 10 : 20)) {
            const alert = await tx.execute(sql`INSERT INTO report_access_alerts(actor_key,kind,hour_start)
              VALUES (${actor ?? 'anonymous'},${kind},date_trunc('hour',now())) ON CONFLICT DO NOTHING RETURNING kind`);
            if (alert.rows.length) {
              for (const userId of await this.grants.accountsWithRole('report_auditor')) {
                await tx.insert(schema.userNotifications).values({ userId, app: 'ads', eventType: 'reports.access_alert', severity: 'warning',
                  title: 'Report access needs review', message: kind === 'repeated_denials' ? 'Repeated report access denials were recorded.' : 'Frequent contact reveals were recorded.',
                  actionUrl: '/admin/reports?view=access', payload: { kind, actorId: actor, correlationId: correlation } });
              }
            }
          }
        }
      });
    } catch {
      throw new ServiceUnavailableException('Report access could not be recorded. Please try again later.');
    }
  }
}
