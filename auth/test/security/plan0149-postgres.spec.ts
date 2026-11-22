import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { tap } from 'rxjs';
import * as schema from '@crimfig/database/schema';
import { AdvertiserMilestonesService } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.service';
import { AdvertiserMilestonesController } from '../../../api/ads-api/src/modules/advertiser-milestones/advertiser-milestones.controller';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';

let service: AdvertiserMilestonesService;
@Module({ controllers: [AdvertiserMilestonesController], providers: [{ provide: AdvertiserMilestonesService, useFactory: () => service }] })
class LocalModule {}
const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;
run('PLAN0149 real PostgreSQL and HTTP recognition', () => {
  let pool: Pool, db: any, app: any, origin: string;
  const jwt = new JwtService({ secret: 'plan0149-disposable-test-secret' });
  const dialect = new PgDialect();
  const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const literal = (value: any): string => value === null ? 'null' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : "'" + String(value).replace(/'/g, "''") + "'";
  function defaultSql(value: any) {
    if (value && typeof value === 'object' && 'queryChunks' in value) {
      const query = dialect.sqlToQuery(value);
      return query.sql.replace(/\$(\d+)/g, (_match, index) => literal(query.params[Number(index) - 1]));
    }
    return literal(value);
  }
  beforeAll(async () => {
    const url = new URL(process.env.PLAN0009_PG_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25449' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') throw new Error('Refusing non-disposable database');
    pool = new Pool({ connectionString: url.href, max: 6, statement_timeout: 10000 });
    db = drizzle(pool, { schema });
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,status text)');
    const tables = [schema.billingWallets,schema.billingTransactions,schema.billingProviderEvents,schema.adsCampaigns,
      schema.adsCampaignEscrows,schema.adsPromoters,schema.adsServes,schema.adsInteractions,schema.adsSettlementClaims,
      schema.adsSettlementBatches,schema.adsPromoterSettlementItems,schema.adsModerationDecisions,schema.adsSettlementRebates,
      schema.adsOpportunityReservations,schema.advertiserAchievements];
    const enums = new Set<string>();
    for (const table of tables) for (const column of getTableConfig(table).columns as any[]) {
      if (column.enum && !enums.has(column.enum.enumName)) {
        enums.add(column.enum.enumName);
        await pool.query(`CREATE TYPE ${quote(column.enum.enumName)} AS ENUM (${column.enum.enumValues.map(literal).join(',')})`);
      }
    }
    // Actual column/default and uniqueness definitions. Unused domain FKs are outside this read-contract fixture.
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = config.columns.map((column: any) => `${quote(column.name)} ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}${column.default !== undefined ? ' DEFAULT ' + (column.getSQLType() === 'jsonb' && typeof column.default === 'object' && !('queryChunks' in column.default) ? literal(JSON.stringify(column.default)) : defaultSql(column.default)) : ''}`);
      for (const constraint of config.uniqueConstraints) columns.push(`UNIQUE (${constraint.columns.map(column => quote(column.name)).join(',')})`);
      await pool.query(`CREATE TABLE ${quote(config.name)} (${columns.join(',')})`);
    }
    await pool.query(readFileSync(resolve(__dirname, '../../../database/migrations/0052_advertiser_recognition.sql'), 'utf8'));
    service = new AdvertiserMilestonesService(db);
    app = await NestFactory.create(LocalModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt, new Reflector(), db, { rolesFor: () => [] } as any));
    app.useGlobalInterceptors({ intercept(context: any, next: any) { return next.handle().pipe(tap(() => {
      if (context.switchToHttp().getRequest().headers['x-test-drop-response'] === '1') context.switchToHttp().getResponse().destroy();
    })); } });
    await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  }, 30000);
  afterAll(async () => { await app?.close(); await pool?.end(); });
  async function user() {
    const id = randomUUID(); await pool.query("INSERT INTO users VALUES ($1,$2,'ACTIVE')", [id, id + '@example.test']); return id;
  }
  function request(actor?: string, evaluate = false, drop = false) {
    return fetch(origin + '/api/v1/advertiser/milestones' + (evaluate ? '/evaluate' : ''), { method: evaluate ? 'POST' : 'GET',
      headers: { ...(actor ? { Authorization: 'Bearer ' + jwt.sign({ sub: actor, email: actor + '@example.test', type: 'access' }, { expiresIn: '5m' }) } : {}), ...(drop ? { 'x-test-drop-response': '1' } : {}) }, signal: AbortSignal.timeout(15000) });
  }
  async function report(owner: string) { return (await (await request(owner)).json() as any).data; }

  /** Synthetic canonical receipts matching current Billing producers. No provider or financial service is called. */
  async function campaign(cents: number, owner = '') {
    owner ||= await user();
    const publisher = await user(), preparedBy = await user(), reviewedBy = await user();
    const id = randomUUID(), submission = randomUUID(), escrow = randomUUID(), batch = randomUUID();
    const item = randomUUID(), receipt = randomUUID(), funding = randomUUID(), draft = randomUUID(), requestId = randomUUID();
    const spendKey = 'ads-settlement:v3:' + id + ':' + requestId;
    const earned = Math.floor(cents * .55), reference = 'fixture-funding-' + funding;
    await db.insert(schema.billingWallets).values({ userId: owner, balanceUsdCents: 0, lockedUsdCents: 0 }).onConflictDoNothing();
    await db.insert(schema.billingTransactions).values({ id: funding, userId: owner, type: 'wallet_fund', status: 'completed', provider: 'paystack',
      amountUsdCents: cents, amountNgnKobo: cents * 100, reference, idempotencyKey: 'wallet-fund:v2:' + funding,
      metadata: JSON.stringify({ fundingVersion: 2, fundingCompletion: { version: 2, reference, domain: 'live', currency: 'NGN', amountNgnKobo: cents * 100 } }) });
    await db.insert(schema.adsCampaigns).values({ id, advertiserId: owner, title: 'Private advertiser title', budgetUsdCents: cents, remainingBudgetUsdCents: 0,
      status: 'completed', moderationStatus: 'approved', contentRevision: 1, currentSubmissionId: submission, approvedSubmissionId: submission, approvedRevision: 1 });
    await db.insert(schema.adsModerationDecisions).values({ targetType: 'campaign', targetId: id, submissionId: submission, contentRevision: 1,
      stage: 'manager', decision: 'approved', reviewerId: reviewedBy });
    await db.insert(schema.adsCampaignEscrows).values({ id: escrow, campaignId: id, userId: owner, allocatedUsdCents: cents, consumedUsdCents: cents, refundedUsdCents: 0, status: 'exhausted' });
    await db.insert(schema.billingTransactions).values({ userId: owner, type: 'internal_debit', provider: 'internal', status: 'completed', amountUsdCents: cents,
      balanceBeforeUsdCents: cents, balanceAfterUsdCents: 0, idempotencyKey: 'ads-escrow:v2:' + escrow + ':reserve:' + cents,
      metadata: JSON.stringify({ version: 2, kind: 'campaign_escrow', action: 'reserve', campaignId: id, escrowId: escrow, allocatedUsdCents: cents, lockedBeforeUsdCents: 0, lockedAfterUsdCents: cents }) });
    const [promoter] = await db.insert(schema.adsPromoters).values({ userId: publisher, type: 'INDIVIDUAL' }).returning();
    const [serve] = await db.insert(schema.adsServes).values({ campaignId: id, promoterId: promoter.id, slotHandle: randomUUID(), inventoryClass: 'paid', deliveryMode: 'normal', financialEligibility: 'eligible' }).returning();
    const [event] = await db.insert(schema.adsInteractions).values({ promoterId: promoter.id, serveId: serve.id, type: 'viewable_impression', verificationVersion: 2, isValid: true, financialEligibility: 'eligible', assessmentStatus: 'validated' }).returning();
    await db.insert(schema.adsSettlementBatches).values({ id: batch, batchNumber: 'fixture-' + batch, periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-02'), status: 'completed', totalDebitedUsdCents: cents, idempotencyKey: spendKey });
    await db.insert(schema.adsSettlementClaims).values({ interactionId: event.id, serveId: serve.id, escrowId: escrow, allocatedUsdCents: cents, promoterId: promoter.id, batchId: batch, priceNanos: BigInt(cents) * 10000000n });
    await db.insert(schema.billingProviderEvents).values({ id: draft, provider: 'paystack', reference: 'internal.ad.clearance:' + item, eventType: 'internal.ad.clearance', processed: true,
      rawPayload: { version: 3, itemId: item, evidenceId: 'review-' + item, preparedBy, amountUsdCents: earned, billedUsdCents: cents } });
    await db.insert(schema.billingTransactions).values({ id: receipt, userId: publisher, type: 'ads_earning', provider: 'internal', status: 'completed', amountUsdCents: earned, grossAmountUsdCents: cents, idempotencyKey: 'ads-earning:v3:' + item,
      metadata: JSON.stringify({ version: 3, kind: 'funded_ad_earning', itemId: item, batchId: batch, campaignId: id, escrowId: escrow, promoterId: promoter.id, settlementClaimId: event.id,
        clearance: { draftId: draft, evidenceId: 'review-' + item, preparedBy, reviewedBy } }) });
    await db.insert(schema.adsPromoterSettlementItems).values({ id: item, batchId: batch, promoterId: promoter.id, campaignId: id, earnedUsdCents: earned, billedUsdCents: cents, billingTransactionId: receipt,
      idempotencyKey: 'ads-item:v3:' + event.id, status: 'credited', clearanceStatus: 'cleared', holdExpiresAt: new Date('2026-11-05'), clearedAt: new Date('2026-11-06') });
    await db.insert(schema.billingTransactions).values({ userId: owner, type: 'ads_spend', provider: 'internal', status: 'completed', amountUsdCents: cents,
      idempotencyKey: spendKey, reference: 'ads-spend-v3-' + batch, metadata: JSON.stringify({ version: 3, kind: 'funded_ad_spend', campaignId: id, escrowId: escrow, batchId: batch }) });
    return { owner, id, item, eventId: event.id, serveId: serve.id, funding, receipt, batch };
  }

  it('rejects anonymous reads and evaluations', async () => {
    expect((await request()).status).toBe(401); expect((await request(undefined, true)).status).toBe(401);
  });
  it('rejects unknown funding, simulations and unfinished campaigns', async () => {
    for (const mutation of ['test_funding', 'simulation', 'unfinished', 'pending_clearance', 'bonus']) {
      const fixture = await campaign(500);
      if (mutation === 'test_funding') await pool.query("UPDATE billing_transactions SET metadata=jsonb_set(metadata::jsonb,'{fundingCompletion,domain}','\"test\"')::text WHERE id=$1", [fixture.funding]);
      if (mutation === 'simulation') await pool.query("UPDATE ads_serves SET inventory_class='simulated_paid' WHERE id=$1", [fixture.serveId]);
      if (mutation === 'unfinished') await pool.query("UPDATE ads_campaigns SET status='active' WHERE id=$1", [fixture.id]);
      if (mutation === 'pending_clearance') await pool.query("UPDATE ads_promoter_settlement_items SET clearance_status='pending' WHERE id=$1", [fixture.item]);
      if (mutation === 'bonus') await pool.query('UPDATE ads_campaigns SET is_bonus_delivery=true WHERE id=$1', [fixture.id]);
      await service.evaluateCategoryAMilestones(fixture.owner);
      expect((await pool.query('SELECT count(*) FROM advertiser_recognition_awards WHERE advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('0');
    }
  });
  it('does not combine two smaller campaigns for A1 and counts three distinct campaigns for A2', async () => {
    const first = await campaign(300); await campaign(200, first.owner);
    const split = await service.evaluateCategoryAMilestones(first.owner);
    expect(split.definitions.find(rule => rule.tier === 'A1_FIRST_CAMPAIGN')?.state).not.toBe('EARNED');
    await campaign(100, first.owner);
    const three = await service.evaluateCategoryAMilestones(first.owner);
    expect(three.definitions.find(rule => rule.tier === 'A2_CONSISTENT')?.state).toBe('EARNED');
    expect(three.progress.eligibleClearedSpendCents).toBe(600);
  });
  it('keeps GET read-only, unlocks one A1 under concurrent POSTs and leaves all financial balances unchanged', async () => {
    const fixture = await campaign(500);
    const before = await pool.query('SELECT balance_usd_cents,locked_usd_cents FROM billing_wallets WHERE user_id=$1', [fixture.owner]);
    expect((await report(fixture.owner)).definitions[0].state).toBe('QUALIFIED');
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_awards WHERE advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('0');
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(fixture.owner, true)));
    expect(responses.every(response => response.status === 201)).toBe(true);
    expect((await report(fixture.owner)).definitions[0].state).toBe('EARNED');
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_awards WHERE advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('1');
    expect((await pool.query('SELECT balance_usd_cents,locked_usd_cents FROM billing_wallets WHERE user_id=$1', [fixture.owner])).rows).toEqual(before.rows);
    expect((await pool.query('SELECT count(*) FROM advertiser_achievements WHERE advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('0');
  });
  it('recovers a lost response without another award or transition', async () => {
    const fixture = await campaign(500);
    await expect(request(fixture.owner, true, true)).rejects.toThrow();
    const retry = await request(fixture.owner, true);
    expect(retry.status).toBe(201);
    expect((await retry.json() as any).data.newlyAwarded).toEqual([]);
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_evaluations e JOIN advertiser_recognition_awards a ON a.id=e.award_id WHERE a.advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('1');
  });
  it('returns an award to review after invalidation and retains its original identity after recovery', async () => {
    const fixture = await campaign(500);
    await service.evaluateCategoryAMilestones(fixture.owner);
    const original = (await report(fixture.owner)).badges[0];
    await pool.query('UPDATE ads_interactions SET is_valid=false WHERE id=$1', [fixture.eventId]);
    expect((await report(fixture.owner)).badges[0].state).toBe('under_review');
    await service.evaluateCategoryAMilestones(fixture.owner);
    await pool.query('UPDATE ads_interactions SET is_valid=true WHERE id=$1', [fixture.eventId]);
    await service.evaluateCategoryAMilestones(fixture.owner);
    expect((await report(fixture.owner)).badges[0]).toMatchObject({ id: original.id, state: 'qualified', achievedAt: original.achievedAt });
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_evaluations WHERE award_id=$1', [original.id])).rows[0].count).toBe('3');
  });
  it('rolls back the award if its audit append fails', async () => {
    const fixture = await campaign(500);
    await pool.query("CREATE FUNCTION fail_recognition_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER fail_recognition_fixture BEFORE INSERT ON advertiser_recognition_evaluations FOR EACH ROW EXECUTE FUNCTION fail_recognition_fixture()");
    try { await expect(service.evaluateCategoryAMilestones(fixture.owner)).rejects.toThrow('fixture rollback'); }
    finally { await pool.query('DROP TRIGGER fail_recognition_fixture ON advertiser_recognition_evaluations; DROP FUNCTION fail_recognition_fixture()'); }
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_awards WHERE advertiser_id=$1', [fixture.owner])).rows[0].count).toBe('0');
  });
  it('does not count duplicate event receipts, unsupported wallet credits or unreconciled wallet totals', async () => {
    const duplicate = await campaign(500);
    await pool.query('INSERT INTO ads_promoter_settlement_items SELECT gen_random_uuid(),batch_id,promoter_id,placement_id,campaign_id,impressions_count,clicks_count,hovers_count,touches_count,earned_usd_cents,billed_usd_cents,revenue_policy_id,tier_snapshot,publisher_pool_ratio,crimfig_base_revenue_ratio,commission_pool_ratio,platform_share_ratio,tax_and_fees_ratio,exchange_rate_snapshot,billing_transaction_id,idempotency_key,clearance_status,hold_expires_at,cleared_at,status,created_at FROM ads_promoter_settlement_items WHERE id=$1', [duplicate.item]);
    expect((await report(duplicate.owner)).definitions[0].state).not.toBe('QUALIFIED');
    const mixed = await campaign(500);
    await db.insert(schema.billingTransactions).values({ userId: mixed.owner, type: 'rewards_credit', provider: 'internal', status: 'completed', amountUsdCents: 100 });
    expect((await report(mixed.owner)).progress.verifiedCompletedCampaigns).toBeNull();
    const inconsistent = await campaign(500);
    await pool.query('UPDATE billing_wallets SET balance_usd_cents=1 WHERE user_id=$1', [inconsistent.owner]);
    expect((await report(inconsistent.owner)).progress.verifiedCompletedCampaigns).toBeNull();
  });
  it('isolates owner history and supports a non-writing scheduled preview', async () => {
    const fixture = await campaign(500), other = await user();
    await service.evaluateCategoryAMilestones(fixture.owner);
    expect((await report(other)).badges).toEqual([]);
    expect((await report(other)).progress.totalCampaigns).toBe(0);
    const before = (await pool.query('SELECT count(*) FROM advertiser_recognition_awards')).rows[0].count;
    await service.reconcile(null, false, async () => {});
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_awards')).rows[0].count).toBe(before);
  });
  it('rejects mismatched source ownership, premature clearance and pending event eligibility', async () => {
    const mismatch = await campaign(500);
    await pool.query('UPDATE ads_interactions SET serve_id=$1 WHERE id=$2', [randomUUID(), mismatch.eventId]);
    expect((await report(mismatch.owner)).definitions[0].state).not.toBe('QUALIFIED');
    const premature = await campaign(500);
    await pool.query("UPDATE ads_promoter_settlement_items SET cleared_at=hold_expires_at-interval '1 second' WHERE id=$1", [premature.item]);
    expect((await report(premature.owner)).definitions[0].state).not.toBe('QUALIFIED');
    const pending = await campaign(500);
    await pool.query("UPDATE ads_interactions SET financial_eligibility='pending' WHERE id=$1", [pending.eventId]);
    expect((await report(pending.owner)).definitions[0].state).not.toBe('QUALIFIED');
  });
  it('keeps evaluation history immutable and fences a scheduled evaluation after lease loss', async () => {
    const fixture = await campaign(500);
    await service.evaluateCategoryAMilestones(fixture.owner);
    const award = (await report(fixture.owner)).badges[0];
    await expect(pool.query('DELETE FROM advertiser_recognition_evaluations WHERE award_id=$1', [award.id])).rejects.toThrow();
    await expect(pool.query("UPDATE advertiser_recognition_evaluations SET state='revoked' WHERE award_id=$1", [award.id])).rejects.toThrow();
    const before = (await pool.query('SELECT count(*) FROM advertiser_recognition_evaluations')).rows[0].count;
    await expect(service.reconcile(null, true, async () => { throw new Error('lease lost'); })).rejects.toThrow('lease lost');
    expect((await pool.query('SELECT count(*) FROM advertiser_recognition_evaluations')).rows[0].count).toBe(before);
  });
});
