import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as schema from '@crimfig/database/schema';
import { AdminReportsController } from '../../../api/ads-api/src/modules/report-access/reports.controller';
import { ReportAuditService } from '../../../api/ads-api/src/modules/report-access/report-audit.service';
import { ReportAuditInterceptor } from '../../../api/ads-api/src/modules/report-access/report-audit.interceptor';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { DATABASE_TOKEN } from '../../../api/ads-api/src/modules/database/database.module';
import { ReportsController } from '../../../api/ads-api/src/modules/analytics/reports.controller';
import { ReportsService } from '../../../api/ads-api/src/modules/analytics/reports.service';

let database: any;
@Module({ controllers: [AdminReportsController, ReportsController], providers: [
  { provide: DATABASE_TOKEN, useFactory: () => database },
  { provide: ReportsService, useValue: { daily: async () => ({ totals: {} }) } },
] })
class LocalModule {}
const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;
run('PLAN0144 real PostgreSQL and HTTP report access', () => {
  let pool: Pool, app: any, origin: string, audit: ReportAuditService;
  const admin = randomUUID(), finance = randomUUID(), auditor = randomUUID(), reveal = randomUUID(), owner = randomUUID();
  const jwt = new JwtService({ secret: 'plan0144-disposable-access-secret' });
  let grants: AdsStaffGrants;
  beforeAll(async () => {
    const url = new URL(process.env.PLAN0009_PG_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25451' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') throw new Error('Refusing non-disposable database');
    pool = new Pool({ connectionString: url.href, max: 6, statement_timeout: 10000 });
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,phone text,status text)');
    await pool.query('CREATE TABLE ads_serves(served_at timestamptz,inventory_class text,delivery_mode text,financial_eligibility text)');
    await pool.query('CREATE TABLE billing_transactions(type text,status text,amount_usd_cents integer,created_at timestamptz)');
    await pool.query("CREATE TABLE user_notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,app text,event_type text,severity text,title text,message text,action_url text,is_read boolean DEFAULT false,read_at timestamptz,is_archived boolean DEFAULT false,payload jsonb,created_at timestamptz DEFAULT now())");
    await pool.query(readFileSync(resolve(__dirname, '../../../database/migrations/0051_report_access_audit.sql'), 'utf8'));
    for (const id of [admin,finance,auditor,reveal,owner]) await pool.query("INSERT INTO users VALUES($1,$2,'+2348012345678','ACTIVE')", [id, id === owner ? 'private-contact@example.test' : id + '@example.test']);
    await pool.query(readFileSync(resolve(__dirname, '../../../database/migrations/0054_platform_access.sql'), 'utf8'));
    for(const [userId,roles]of Object.entries({[admin]:['ads_admin'],[finance]:['ads_finance'],[auditor]:['report_auditor'],[reveal]:['ads_support','report_contact_reveal']}))for(const role of roles)await pool.query("INSERT INTO platform_user_role_grants(user_id,role_key,scope,state,source) VALUES($1,$2,'ads','active','isolated-fixture')",[userId,role]);
    grants=new AdsStaffGrants(drizzle(pool));
    database = drizzle(pool, { schema });
    audit = new ReportAuditService(database, grants);
    app = await NestFactory.create(LocalModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt, new Reflector(), database, grants, audit));
    app.useGlobalInterceptors(new ReportAuditInterceptor(audit));
    await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  }, 30000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  function call(actor: string | undefined, route: string, body?: any) {
    return fetch(origin + '/api/v1/' + route, { method: body ? 'POST' : 'GET',
      headers: { ...(actor ? { Authorization: 'Bearer ' + jwt.sign({ sub: actor, email: actor + '@example.test', type: 'access' }, { expiresIn: '5m' }) } : {}), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  }
  it('audits unauthenticated and independently denied finance, reveal and audit access', async () => {
    expect((await call(undefined, 'admin/reports/contacts')).status).toBe(401);
    expect((await call(owner, 'admin/reports/delivery')).status).toBe(403);
    expect((await call(admin, 'admin/reports/finance')).status).toBe(403);
    expect((await call(finance, 'admin/reports/access')).status).toBe(403);
    expect((await call(admin, 'admin/reports/contacts/' + owner + '/reveal', { field: 'email', reason: 'account_support' })).status).toBe(403);
    expect((await pool.query("SELECT count(*) FROM report_access_audit WHERE outcome='denied'")).rows[0].count).toBe('5');
  });
  it('never returns raw contacts in lists or audit and reveals only with an explicit grant and reason', async () => {
    const response = await call(admin, 'admin/reports/contacts?search=private-contact@example.test');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    const raw = await response.text(); expect(raw).not.toContain('private-contact@example.test'); expect(raw).not.toContain('+2348012345678');
    expect(raw).toContain('p***@example.test');
    expect((await call(reveal, 'admin/reports/contacts/' + owner + '/reveal', { field: 'email', reason: 'freeform-private' })).status).toBe(400);
    const revealed = await call(reveal, 'admin/reports/contacts/' + owner + '/reveal', { field: 'email', reason: 'account_support' });
    expect(revealed.status).toBe(201); expect(revealed.headers.get('cache-control')).toContain('no-store');
    expect((await revealed.json() as any).data).toMatchObject({ value: 'private-contact@example.test', remaskAfterSeconds: 30 });
    const access = await call(auditor, 'admin/reports/access');
    const auditText = await access.text(); expect(auditText).not.toContain('private-contact@example.test'); expect(auditText).not.toContain('+2348012345678');
    expect(auditText).toContain('account_support');
  });
  it('blocks a reveal before returning private values when the audit store is unavailable', async () => {
    await pool.query('ALTER TABLE report_access_audit RENAME TO audit_unavailable');
    try {
      const response = await call(reveal, 'admin/reports/contacts/' + owner + '/reveal', { field: 'phone', reason: 'payment_investigation' });
      expect(response.status).toBe(503); expect(await response.text()).not.toContain('+2348012345678');
    } finally { await pool.query('ALTER TABLE audit_unavailable RENAME TO report_access_audit'); }
  });
  it('audits daily report reads and validation failures without raw filter payloads', async () => {
    const before = await pool.query('SELECT coalesce(max(position), 0) AS position FROM report_access_audit');
    expect((await call(owner, 'reports/daily?role=promoter&from=2026-11-20')).status).toBe(200);
    expect((await call(admin, 'admin/reports/contacts?page=private-contact@example.test')).status).toBe(400);
    const result = await pool.query('SELECT action,outcome,scope FROM report_access_audit WHERE position > $1 ORDER BY position', [before.rows[0].position]);
    expect(result.rows.map(row => [row.action, row.outcome])).toEqual([
      ['report.daily', 'allowed'],
      ['report.admin', 'failed'],
    ]);
    expect(JSON.stringify(result.rows)).not.toContain('private-contact@example.test');
  });
  it('serializes concurrent audit appends, rejects rewriting and verifies the hash chain', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => call(admin, 'admin/reports/overview')));
    expect(responses.every(response => response.status === 200)).toBe(true);
    await expect(pool.query("UPDATE report_access_audit SET reason_code='changed'")).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM report_access_audit')).rejects.toThrow('append-only');
    await expect(pool.query('TRUNCATE report_access_audit')).rejects.toThrow('append-only');
    const integrity = await call(auditor, 'admin/reports/access/integrity');
    expect((await integrity.json() as any).data.invalid_entries).toBe('0');
  });
  it('deduplicates burst alerts and routes only to assigned auditors', async () => {
    for (let index = 0; index < 10; index++) expect((await call(owner, 'admin/reports/finance')).status).toBe(403);
    const notifications = await pool.query("SELECT user_id,event_type,payload FROM user_notifications WHERE event_type='reports.access_alert'");
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0].user_id).toBe(auditor);
    expect(notifications.rows[0].payload.kind).toBe('repeated_denials');
  });
  it('uses source amounts and permissioned aggregates without contact or campaign labels', async () => {
    await pool.query("INSERT INTO ads_serves VALUES ('2026-11-20T12:00:00Z','paid','normal','eligible'),('2026-11-20T12:00:00Z','simulated_paid','normal','eligible')");
    await pool.query("INSERT INTO billing_transactions VALUES ('ads_spend','completed',500,'2026-11-20T12:00:00Z'),('wallet_fund','completed',10000,'2026-11-20T12:00:00Z')");
    const delivery = await call(admin, 'admin/reports/delivery?from=2026-11-20&to=2026-11-20');
    expect((await delivery.json() as any).data.metrics.paid_serves).toBe('1');
    const financeReport = await call(finance, 'admin/reports/finance?from=2026-11-20&to=2026-11-20');
    expect((await financeReport.json() as any).data.metrics.posted_ad_spend_cents).toBe('500');
  });
});
