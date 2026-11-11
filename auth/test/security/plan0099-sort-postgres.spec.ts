import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import * as schema from '@crimfig/database/schema';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
import { CampaignsController } from '../../../api/ads-api/src/modules/campaigns/campaigns.controller';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';
import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

// Uses the existing disposable runner and the funding suite's schema construction.
// Never reads application .env or connects to a shared database.
const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;
run('PLAN0099 real PostgreSQL campaign column sorting', () => {
  let pool: Pool, db: any, owner: string, rateId: string;
  const dialect = new PgDialect();
  const quote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const literal = (value: any): string => value === null ? 'null' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : "'" + String(value).replace(/'/g, "''") + "'";
  const defaultSql = (value: any) => {
    if (value && typeof value === 'object' && 'queryChunks' in value) {
      const query = dialect.sqlToQuery(value);
      return query.sql.replace(/\$(\d+)/g, (_match, index) => literal(query.params[Number(index)-1]));
    }
    return literal(value);
  };
  beforeAll(async () => {
    const url = new URL(process.env.PLAN0009_PG_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '25439' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') throw Error('Refusing non-disposable database');
    if (process.env.PLAN0009_REDIS_URL) {
      const redisUrl = new URL(process.env.PLAN0009_REDIS_URL);
      if (redisUrl.protocol !== 'redis:' || redisUrl.hostname !== '127.0.0.1' || redisUrl.port !== '26379' || !redisUrl.password) throw Error('Refusing non-disposable Redis');
    }
    pool = new Pool({ connectionString: url.href, max: 12, connectionTimeoutMillis: 3000 });
    db = drizzle(pool, { schema });
    await pool.query("create table users(id uuid primary key,email text not null,status text not null,is_email_verified boolean default false,preferred_locale text default 'en')");
    await pool.query('create table apps(id uuid primary key)');
    // Actual Drizzle columns/defaults/enums/unique constraints/FKs, not the serialized mock adapter.
    // User identity is a minimal FK fixture; no production migrations or existing records are used.
    const tables = [schema.billingExchangeRates, schema.billingWallets, schema.billingTransactions, schema.billingSavedCards, schema.billingProviderEvents, schema.refreshTokens, schema.adsCampaigns, schema.adsCampaignEscrows, schema.billingBankAccounts, schema.billingWithdrawalRequests, schema.billingSubscriptions, schema.adsCreativeStacks, schema.adsCreatives, schema.adsPromoters, schema.adsReelsConsents, schema.adsPromoterWebsites, schema.adsPromoterApps, schema.adstationSlots, schema.adstationDirectCampaigns, schema.adsSupplyStateHistory, schema.adsTrafficControls, schema.adsEvidenceRecords, schema.adsPlacements, schema.adsServes, schema.adsInteractions, schema.adsAuctionDecisions, schema.adsOpportunityReservations, schema.adsEventAssessments, schema.adsSettlementBatches, schema.adsPromoterSettlementItems, schema.adsSettlementClaims, schema.adsSettlementCarries, schema.adsDeepAuditRuns, schema.adsSettlementRebates, schema.adsPromoterPenalties, schema.oauthClients];
    const enums = new Set<string>();
    tables.splice(tables.indexOf(schema.adsCreatives), 0, schema.adsMediaAssets as any, schema.crimfigGeoTargets as any, schema.adsHouseCreatives as any);
    for (const table of tables) for (const col of getTableConfig(table).columns as any[]) {
      if (col.enum && !enums.has(col.enum.enumName)) {
        enums.add(col.enum.enumName); await pool.query(`create type ${quote(col.enum.enumName)} as enum (${col.enum.enumValues.map(literal).join(',')})`);
      }
    }
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = config.columns.map((col: any) => `${quote(col.name)} ${col.getSQLType()}${col.primary?' primary key':''}${col.notNull?' not null':''}${col.isUnique?' unique':''}${col.default!==undefined?' default '+(col.getSQLType()==='jsonb' && typeof col.default==='object' && !('queryChunks' in col.default) ? literal(JSON.stringify(col.default)) : defaultSql(col.default)):''}`);
      for (const unique of config.uniqueConstraints) columns.push(`constraint ${quote(unique.name!)} unique (${unique.columns.map(col=>quote(col.name)).join(',')})`);
      for (const fk of config.foreignKeys) { const ref = fk.reference(); columns.push(`foreign key (${ref.columns.map(col=>quote(col.name)).join(',')}) references ${quote(getTableName(ref.foreignTable))} (${ref.foreignColumns.map(col=>quote(col.name)).join(',')})`); }
      await pool.query(`create table ${quote(config.name)} (${columns.join(',')})`);
    }
    const clients = await Promise.all([pool.connect(),pool.connect(),pool.connect()]);
    try { const ids = await Promise.all(clients.map(client=>client.query('select pg_backend_pid() id'))); expect(new Set(ids.map(result=>result.rows[0].id)).size).toBe(3); } finally { clients.forEach(client=>client.release()); }
  }, 30000);
  beforeEach(async () => {
    await pool.query('truncate ads_settlement_batches,billing_provider_events,billing_saved_cards,billing_transactions,billing_wallets,billing_exchange_rates,refresh_tokens,ads_campaign_escrows,ads_campaigns,users,apps cascade');
    owner=randomUUID();rateId=randomUUID();
    await pool.query('insert into users(id,email,status) values($1,$2,$3)',[owner,'owner@example.test','ACTIVE']);
    await pool.query("insert into billing_exchange_rates(id,usd_to_ngn,source) values($1,100,'exchangerate_api')",[rateId]);
  });
  afterAll(async () => { await pool?.end(); });
  async function campaignFixture() {
    const [campaign] = await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Sort fixture',budgetUsdCents:1000,
      remainingBudgetUsdCents:1000,status:'paused',moderationStatus:'approved'}).returning();
    const publisher=randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'publisher@example.test','ACTIVE')",[publisher]);
    const [promoter]=await db.insert(schema.adsPromoters).values({userId:publisher,type:'INDIVIDUAL'}).returning();
    const [stack]=await db.insert(schema.adsCreativeStacks).values({campaignId:campaign.id,name:'Ad Stack',position:1}).returning();
    const [creative]=await db.insert(schema.adsCreatives).values({campaignId:campaign.id,adStackId:stack.id,headline:'Reviewed',destinationUrl:'https://example.test',status:'active',reviewStatus:'approved'}).returning();
    const [placement]=await db.insert(schema.adsPlacements).values({campaignId:campaign.id,creativeId:creative.id,promoterId:promoter.id,placementToken:randomUUID()}).returning();
    return {campaign,promoter,placement};
  }
  test('PLAN0099 column sorting applies before pagination and excludes foreign and invalid traffic', async () => {
    const own = await campaignFixture();
    await pool.query("update ads_campaigns set title='Alpha',budget_usd_cents=1000,remaining_budget_usd_cents=900,status='paused',moderation_status='approved',created_at='2026-01-01' where id=$1", [own.campaign.id]);
    const [second, empty] = await db.insert(schema.adsCampaigns).values([
      { advertiserId: owner, title: 'Zulu', budgetUsdCents: 2000, remainingBudgetUsdCents: 1700, status: 'paused', moderationStatus: 'pending_manager_approval', createdAt: new Date('2026-01-02') },
      { advertiserId: owner, title: 'Empty', budgetUsdCents: 500, remainingBudgetUsdCents: 500, status: 'draft', createdAt: new Date('2026-01-03') },
    ]).returning();
    const [stack] = await db.insert(schema.adsCreativeStacks).values({ campaignId: second.id, name: 'Second', position: 1 }).returning();
    const creatives = await db.insert(schema.adsCreatives).values([0, 1].map(index => ({
      campaignId: second.id, adStackId: stack.id, headline: `Second ${index}`,
      destinationUrl: 'https://example.test', status: 'active', reviewStatus: 'approved',
    }))).returning();
    const [placement] = await db.insert(schema.adsPlacements).values({ campaignId: second.id, creativeId: creatives[0].id, promoterId: own.promoter.id, placementToken: randomUUID() }).returning();
    await db.insert(schema.adsInteractions).values([
      ...Array.from({ length: 2 }, () => ({ placementId: own.placement.id, promoterId: own.promoter.id, type: 'impression', isValid: true })),
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'click', isValid: true },
      ...Array.from({ length: 12 }, () => ({ placementId: own.placement.id, promoterId: own.promoter.id, type: 'impression', isValid: false })),
      ...Array.from({ length: 5 }, () => ({ placementId: placement.id, promoterId: own.promoter.id, type: 'impression', isValid: true })),
      ...Array.from({ length: 2 }, () => ({ placementId: placement.id, promoterId: own.promoter.id, type: 'click', isValid: true })),
    ] as any);
    const [network, house] = await db.insert(schema.adsServes).values([
      { campaignId: second.id, creativeId: creatives[0].id, promoterId: own.promoter.id, slotHandle: 'network', inventoryClass: 'paid' },
      { campaignId: own.campaign.id, promoterId: own.promoter.id, slotHandle: 'house', inventoryClass: 'house' },
    ]).returning();
    await db.insert(schema.adsInteractions).values([
      ...Array.from({ length: 3 }, () => ({ serveId: network.id, promoterId: own.promoter.id, type: 'impression', isValid: true })),
      ...Array.from({ length: 20 }, () => ({ serveId: house.id, promoterId: own.promoter.id, type: 'impression', isValid: true })),
    ] as any);
    const stranger = randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'sort-stranger@example.test','ACTIVE')", [stranger]);
    await db.insert(schema.adsCampaigns).values({ advertiserId: stranger, title: 'Foreign', budgetUsdCents: 999999, remainingBudgetUsdCents: 0 });
    const service = new CampaignsService(db, {} as any, {} as any);
    const page = (sort: string, number = 1, status = 'all', search = '') => service.campaignPage(owner, status, number, 1, search, sort);

    // Reject malformed requests before running any transaction or producing side effects.
    for (const sort of ['budget;delete from users', 'unknown', 'toString']) {
      await expect(page(sort)).rejects.toThrow('Invalid campaign sort');
    }
    await expect(service.campaignPage(owner, 'all', 0, 1, '', 'budget')).rejects.toThrow('Invalid campaign page');
    expect((await pool.query('select count(*)::int as n from billing_transactions')).rows[0].n).toBe(0);
    expect((await service.campaignPage(randomUUID(), 'all', 1, 1, '', 'views_desc')).items).toEqual([]);

    for (const sort of ['title_desc', 'budget_desc', 'spend_desc', 'creatives_desc', 'views_desc', 'clicks_desc', 'status_desc']) {
      const result = await page(sort);
      expect(result.total).toBe(3);
      expect(result.items.map(item => item.id)).toEqual([second.id]);
    }
    expect((await page('views_desc')).items[0].impressionsCount).toBe(8);
    expect((await page('ctr_desc')).items[0].id).toBe(own.campaign.id); // 50% versus 25%.
    for (const sort of ['budget', 'spend', 'creatives', 'views', 'clicks', 'ctr', 'status']) {
      expect((await page(sort)).items[0].id).toBe(empty.id);
    }
    expect((await page('title')).items[0].id).toBe(own.campaign.id);
    expect((await page('oldest')).items[0].id).toBe(own.campaign.id);
    expect((await page('newest')).items[0].id).toBe(empty.id);
    expect((await page('views_desc', 2)).items[0].id).toBe(own.campaign.id);
    expect((await page('budget_desc', 1, 'under_review')).items[0].id).toBe(second.id);
    expect((await page('budget_desc', 1, 'paused')).items[0].id).toBe(own.campaign.id);
    expect((await page('budget_desc', 1, 'all', 'Alpha')).items[0].id).toBe(own.campaign.id);
  }, 30000);

  test('PLAN0099 sorting traverses authenticated HTTP and denies malformed requests', async () => {
    const own = await campaignFixture();
    @Module({ controllers: [CampaignsController], providers: [
      { provide: CampaignsService, useValue: new CampaignsService(db, {} as any, {} as any) },
    ] })
    class SortFixture {}
    const jwt = new JwtService({ secret: 'plan0099-isolated-sort-fixture-key' });
    const app = await NestFactory.create(SortFixture, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt, new Reflector(), db, { rolesFor: () => [] } as any));
    await app.listen(0, '127.0.0.1');
    const request = async (sort: string, actor?: string) => fetch(
      `${await app.getUrl()}/api/v1/campaigns/page?pageSize=1&sort=${encodeURIComponent(sort)}`,
      { headers: actor ? { Authorization: 'Bearer ' + jwt.sign({ sub: actor, email: 'fixture@example.test', type: 'access' }, { expiresIn: '2m' }) } : {}, signal: AbortSignal.timeout(5000) },
    );
    try {
      expect((await request('budget_desc')).status).toBe(401);
      expect((await request('budget; drop table users', owner)).status).toBe(400);
      for (const sort of ['title_desc', 'status', 'budget_desc', 'spend', 'creatives', 'views_desc', 'clicks', 'ctr_desc']) {
        const response = await request(sort, owner);
        expect(response.status).toBe(200);
        expect((await response.json() as any).data.items[0].id).toBe(own.campaign.id);
      }
      const stranger = randomUUID();
      await pool.query("insert into users(id,email,status) values($1,'http-stranger@example.test','ACTIVE')", [stranger]);
      const response = await request('budget_desc', stranger);
      expect(response.status).toBe(200);
      expect((await response.json() as any).data.items).toEqual([]);
      expect((await pool.query('select count(*)::int as n from billing_transactions')).rows[0].n).toBe(0);
    } finally {
      await app.close();
    }
  }, 30000);
});
