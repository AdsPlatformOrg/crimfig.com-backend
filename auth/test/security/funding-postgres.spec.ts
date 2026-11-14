import { ReportsController } from '../../../api/ads-api/src/modules/analytics/reports.controller';
import { ReportsService } from '../../../api/ads-api/src/modules/analytics/reports.service';
import { AdOpportunityWorker } from '../../../api/billing-api/src/modules/ecosystem/ad-opportunity.worker';
import { AnalyticsController } from '../../../api/ads-api/src/modules/analytics/analytics.controller';
import { AnalyticsService } from '../../../api/ads-api/src/modules/analytics/analytics.service';
import { AdsOperationsController } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.controller';
import { DeliveryController } from '../../../api/ads-api/src/modules/delivery/delivery.controller';
import { DeliveryService, HOUSE_PLACEMENT_UUID } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { ClickAuditController } from '../../../api/ads-api/src/modules/analytics/click-audit.controller';
import { AuctionEngineService } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';
import { EvidenceService } from '../../../api/ads-api/src/modules/delivery/evidence.service';
import { AdOpportunityController } from '../../../api/billing-api/src/modules/ecosystem/ad-opportunity.controller';
import { AdOpportunityService } from '../../../api/billing-api/src/modules/ecosystem/ad-opportunity.service';
import { OpportunityClient, OpportunityConflictError } from '../../../api/ads-api/src/modules/billing/opportunity-client';
import { ConfigService } from '@nestjs/config';
import { eventPriceNanos, reservePriceMicrosForModel } from '../../../api/ads-api/src/modules/delivery/pricing-contract';
import { AdsOperationsService } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';
import { PublisherInventoryController } from '../../../api/ads-api/src/modules/publisher-inventory/publisher-inventory.controller';
import { PublisherSlotsService } from '../../../api/ads-api/src/modules/publisher-inventory/publisher-slots.service';
import { AdminPerformanceController } from '../../../api/ads-api/src/modules/delivery/admin-performance.controller';
import { DATABASE_TOKEN } from '../../../api/ads-api/src/modules/database/database.module';
import { CampaignsController } from '../../../api/ads-api/src/modules/campaigns/campaigns.controller';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { AdstationController } from '../../../api/ads-api/src/modules/adstation/adstation.controller';
import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';
import { SetupChecksService } from '../../../api/ads-api/src/modules/adstation/setup-checks.service';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { AdRejectionService } from '../../../api/billing-api/src/modules/ecosystem/ad-rejection.service';
import { AdClearanceService } from '../../../api/billing-api/src/modules/ecosystem/ad-clearance.service';
import { AdSettlementService } from '../../../api/billing-api/src/modules/ecosystem/ad-settlement.service';
import { SubscriptionPaymentsService } from '../../../api/billing-api/src/modules/subscriptions/subscription-payments.service';
import { SubscriptionRenewalWorker } from '../../../api/billing-api/src/modules/subscriptions/subscription-renewal.worker';
import { RefundReviewService } from '../../../api/billing-api/src/modules/withdrawals/refund-review.service';
import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';
import { WithdrawalDispatchService } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-dispatch.service';
import { ExchangeRateService } from '../../../api/billing-api/src/modules/exchange-rate/exchange-rate.service';
import { WithdrawalLedgerService } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-ledger.service';
import { TokensService } from '../../src/modules/tokens/tokens.service';
import { JwtService } from '@nestjs/jwt';
import { CampaignEscrowService } from '../../../api/billing-api/src/modules/ecosystem/campaign-escrow.service';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { randomUUID, createHash } from 'crypto';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';
import { OAuthService } from '../../src/modules/oauth/oauth.service';
import * as argon2 from 'argon2';
import * as schema from '@crimfig/database/schema';
import { PromotersService } from '../../../api/ads-api/src/modules/promoters/promoters.service';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';

jest.mock('../../src/config/config', () => ({ config: { JWT: { ACCESS_SECRET: 'postgres-test-only-signing-secret', ACCESS_EXPIRES_IN: '2m', REFRESH_EXPIRES_DAYS: 30 },
  REDIS: { URL: process.env.PLAN0009_REDIS_URL || 'redis://127.0.0.1:26379' }, OAUTH: { AUTH_CODE_EXPIRES_SECONDS: 2, ISSUER: 'https://auth.example.test' }, IS_PRODUCTION: false } }));

// Opt-in only. Refuse any endpoint other than the dedicated local disposable cluster/database.
const run = process.env.PLAN0009_PG_URL ? describe : describe.skip;
run('PLAN-0009 real PostgreSQL funding, session and escrow boundaries', () => {
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
    if (url.hostname !== '127.0.0.1' || url.port !== '25432' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') throw Error('Refusing non-disposable database');
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
    const tables = [schema.billingExchangeRates, schema.billingWallets, schema.billingTransactions, schema.billingSavedCards, schema.billingProviderEvents, schema.refreshTokens, schema.adsCampaigns, schema.adsCampaignEscrows, schema.billingBankAccounts, schema.billingWithdrawalRequests, schema.billingSubscriptions, schema.adsCreativeStacks, schema.adsCreatives, schema.adsPromoters, schema.adsReelsConsents, schema.adsPromoterWebsites, schema.adsPromoterApps, schema.adstationSlots, schema.adstationDirectCampaigns, schema.adsSupplyStateHistory, schema.adsTrafficControls, schema.adsEvidenceRecords, schema.adsPlacements, schema.adsServes, schema.adsInteractions, schema.adsClicks, schema.adsAuctionDecisions, schema.adsOpportunityReservations, schema.adsEventAssessments, schema.adsSettlementBatches, schema.adsPromoterSettlementItems, schema.adsSettlementClaims, schema.adsSettlementCarries, schema.adsDeepAuditRuns, schema.adsSettlementRebates, schema.adsPromoterPenalties, schema.oauthClients];
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
  test('PLAN0096 matched Android iOS and desktop delivery traverses real HTTP and Billing reservation', async () => {
    const prior = { ...process.env };
    const key = 'plan0096-isolated-authority';
    Object.assign(process.env, { INTERNAL_ECOSYSTEM_KEY:key, ADS_PAID_SERVING_ENABLED:'true', ADS_PAID_RELEASE_ENABLED:'true',
      ADS_IMPRESSION_SIGNING_KEY:'plan0096-local-impression-secret-32-bytes', ADS_EVIDENCE_HASH_SECRET:'plan0096-local-evidence-secret-32-bytes',
      ADS_AUCTION_POLICY_APPROVAL:JSON.stringify({version:'plan0096-fixture',approvedBy:'JED',approvedAt:'2026-11-06T00:00:00Z',pricing:'second_price',bidderGrouping:'advertiser',floors:'bid_and_clearing',fractionalClosure:'write_off_subcent',pctrBasisPoints:150,eventWindowMs:900000,ingestionToleranceMs:60000}) });
    const f = await settlementFixture();
    await pool.query("update ads_campaigns set target_devices='[\"desktop\",\"mobile\"]',cost_per_click_usd_cents=10,cost_per_impression_usd_cents=50 where id=$1",[f.campaign.id]);
    await pool.query("update ads_creatives set ad_format='banner',ad_type='text' where id=$1",[f.creative.id]);
    await pool.query('update ads_promoters set trust_score=90 where id=$1',[f.promoter.id]);
    const [site] = await db.insert(schema.adsPromoterWebsites).values({promoterId:f.promoter.id,url:'https://mobile.example.test',domain:'mobile.example.test',verificationToken:randomUUID(),verificationMethod:'dns_txt',verificationStatus:'verified',verificationExpiresAt:new Date(Date.now()+86400000),policyStatus:'approved',trustScore:90}).returning();
    const [slot] = await db.insert(schema.adstationSlots).values({websiteId:site.id,promoterId:f.promoter.id,name:'Mobile integration',slotTagId:'cf-slot-plan0096-mobile',slotType:'network',format:'banner',lifecycleStatus:'active',installationStatus:'verified',allowedAdTypes:'["text"]',isActive:true}).returning();
    @Module({controllers:[AdOpportunityController],providers:[
      {provide:AdOpportunityService,useValue:new AdOpportunityService(db)},
    ]}) class MobileDeliveryFixture {}
    const app = await NestFactory.create(MobileDeliveryFixture,{logger:false});
    app.setGlobalPrefix('api/v1'); app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));
    let deliveryApp: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
    try {
      await app.listen(0,'127.0.0.1'); const origin = await app.getUrl(); process.env.BILLING_API_URL=origin;
      const client = new OpportunityClient(new ConfigService({BILLING_API_URL:origin,INTERNAL_ECOSYSTEM_KEY:key}));
      const delivery = new DeliveryService(db,new ImpressionTokenService(),new AuctionEngineService(),new FraudRulesService(),client,new EvidenceService(db,client));
      @Module({controllers:[DeliveryController],providers:[{provide:DeliveryService,useValue:delivery}]}) class AdsDeliveryFixture {}
      deliveryApp = await NestFactory.create(AdsDeliveryFixture,{logger:false});
      deliveryApp.setGlobalPrefix('api/v1');
      await deliveryApp.listen(0,'127.0.0.1'); const deliveryOrigin = await deliveryApp.getUrl();
      const ledgerBefore = (await pool.query('select count(*)::int n from billing_transactions')).rows[0].n;
      const agents = [
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
      ];
      const traces: any[] = [];
      for (const agent of agents) {
        const response = await fetch(deliveryOrigin+'/api/v1/delivery/ad/'+slot.slotTagId+'?domain=mobile.example.test',{headers:{'user-agent':agent,origin:'https://mobile.example.test'}});
        const result: any = await response.json();
        expect({status:response.status,body:result}).toMatchObject({status:200});
        expect(result).toMatchObject({status:'success',data:{isHouseAd:false,impToken:expect.stringMatching(/^imp_/)}});
        const record = (await pool.query('select request_id from ads_serves where slot_id=$1 order by served_at desc limit 1',[slot.id])).rows[0];
        const trace = await new AdsOperationsService(db).getAuctionDecision(record.request_id);
        expect(trace?.inventoryClass).toBe('paid'); expect(trace?.eligibleGroupCount).toBe(1);
        expect(trace?.pricingBreakdown?.reservationState).toBe('ISSUED');
        traces.push(trace);
      }
      expect((await pool.query('select count(*)::int n from ads_serves where slot_id=$1',[slot.id])).rows[0].n).toBe(3);
      expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(ledgerBefore);
      const fs = require('fs'); const path = require('path');
      fs.writeFileSync(path.resolve(__dirname,'../../../../docs/reviews/plan-0096/integration-contract.json'),JSON.stringify(traces.map(trace=>({inventoryClass:trace.inventoryClass,evaluatedCandidates:trace.evaluatedCandidates,excludedCandidates:trace.excludedCandidates})),null,2));
      await db.insert(schema.adsHouseCreatives).values({title:'House fixture',headline:'House fixture',bodyText:'Local test',adType:'text',format:'banner'});
      const reservationsBefore = (await pool.query('select count(*)::int n from ads_opportunity_reservations')).rows[0].n;
      for (const [statement,reason] of [
        ["update ads_campaigns set target_devices='[\"desktop\"]' where id=$1",'DEVICE_MISMATCH'],
        ["update ads_campaigns set target_devices='[\"mobile\"]',cost_per_click_usd_cents=1 where id=$1",'BELOW_MODEL_BID_FLOOR'],
        ["update ads_campaigns set target_devices='{' where id=$1",'INVALID_TARGETING'],
        ["update ads_creatives set ad_format='card' where campaign_id=$1",'CREATIVE_FORMAT_MISMATCH'],
      ]) {
        await pool.query("update ads_campaigns set target_devices='[\"mobile\"]',cost_per_click_usd_cents=10 where id=$1",[f.campaign.id]);
        await pool.query(statement,[f.campaign.id]);
        const response = await fetch(deliveryOrigin+'/api/v1/delivery/ad/'+slot.slotTagId+'?domain=mobile.example.test',{headers:{'user-agent':agents[0],origin:'https://mobile.example.test'}});
        const result: any = await response.json();
        expect({status:response.status,result}).toMatchObject({status:200,result:{data:{isHouseAd:true}}});
        const payload = JSON.parse(Buffer.from(result.data.impToken.slice(4).split('.')[0],'base64url').toString());
        const [record] = (await pool.query('select request_id from ads_serves where id=$1',[payload.servedId])).rows;
        const trace = await new AdsOperationsService(db).getAuctionDecision(record.request_id);
        expect(trace?.excludedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({reasonCode:reason,campaignId:f.campaign.id,creativeId:f.creative.id})]));
        expect(trace?.billingPriceNanos).toBe('0');
        fs.writeFileSync(path.resolve(__dirname,'../../../../docs/reviews/plan-0096/fallback-contract.json'),JSON.stringify({evaluatedCandidates:trace?.evaluatedCandidates,excludedCandidates:trace?.excludedCandidates},null,2));
      }
      expect((await pool.query('select count(*)::int n from ads_opportunity_reservations')).rows[0].n).toBe(reservationsBefore);
      expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(ledgerBefore);
    } finally { await deliveryApp?.close(); await app.close(); process.env=prior; }
  },30000);
  test('PLAN0092 Billing expiry compares interaction events using the PostgreSQL enum', async () => {
    await expect(pool.query("select type = case when true then 'click' else 'viewable_impression' end from ads_interactions limit 1"))
      .rejects.toMatchObject({ code: '42883' });
    const service = new AdOpportunityService(db);
    await expect(db.transaction((tx: typeof db) => (service as any).expire(tx, randomUUID()))).resolves.toBeUndefined();
  });
  test.each(['cpc', 'cpm'] as const)('PLAN0092 Billing HTTP validates, issues and settles %s network events', async model => {
    const key = 'local-plan0092-authority-key';
    const previousEnv = { ...process.env };
    process.env.INTERNAL_ECOSYSTEM_KEY = key;
    process.env.ADS_PAID_RELEASE_ENABLED = 'false';
    @Module({controllers:[AdOpportunityController],providers:[{provide:AdOpportunityService,useValue:new AdOpportunityService(db)}]})
    class BillingHandoffFixture {}
    const app = await NestFactory.create(BillingHandoffFixture, {logger:false});
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));
    try {
      await app.listen(0,'127.0.0.1');
      const origin = await app.getUrl();
      const base = `${origin}/api/v1/ecosystem/ad-opportunities`;
      const id = randomUUID();
      const request = (body: object, internalKey?: string) => fetch(`${base}/reserve`, {
        method:'POST',headers:{'Content-Type':'application/json',...(internalKey?{'x-internal-key':internalKey}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(5000),
      });
      const body = {serveBefore:new Date(Date.now()+5000).toISOString(),opportunityId:id,campaignId:randomUUID(),creativeId:randomUUID(),submissionId:randomUUID(),contentRevision:1,promoterId:randomUUID(),websiteId:randomUUID(),slotId:randomUUID(),policyVersion:'fixture',priceNanos:'1000',clearingPriceMicros:1,visitorKey:'a'.repeat(64),ipHash:'a'.repeat(16),decision:{}};
      expect((await request(body)).status).toBe(401);
      expect((await request({...body, opportunityId:'invalid'},key)).status).toBe(400);
      expect((await request(body,key)).status).toBe(503);
      expect((await request(body,key)).status).toBe(503);
      expect((await pool.query('select count(*)::int n from ads_opportunity_reservations where opportunity_id=$1',[id])).rows[0].n).toBe(0);
      expect((await fetch(`${base}/${id}`,{headers:{'x-internal-key':key},signal:AbortSignal.timeout(5000)})).status).toBe(404);
      const f = await settlementFixture(undefined, model);
      const [reservation] = await db.insert(schema.adsOpportunityReservations).values({
        opportunityId:id,campaignId:f.campaign.id,expiresAt:new Date(Date.now()+5000),
      }).returning();
      const read = await fetch(`${base}/${reservation.id}`,{headers:{'x-internal-key':key},signal:AbortSignal.timeout(5000)});
      expect(read.status).toBe(200);
      expect((await read.json() as any).data).toMatchObject({authorityVersion:'opportunity-v1',reservationId:reservation.id,opportunityId:id,state:'HELD'});

      Object.assign(process.env, {
        ADS_PAID_SERVING_ENABLED:'true',ADS_PAID_RELEASE_ENABLED:'true',ADS_EVIDENCE_HASH_SECRET:'plan0092-local-evidence-secret-32-bytes',
        ADS_AUCTION_POLICY_APPROVAL:JSON.stringify({version:'plan0092-fixture',approvedBy:'JED',approvedAt:'2026-11-03T00:00:00Z',pricing:'second_price',bidderGrouping:'advertiser',floors:'bid_and_clearing',fractionalClosure:'write_off_subcent',pctrBasisPoints:150,eventWindowMs:900000,ingestionToleranceMs:60000}),
      });
      await pool.query('update ads_campaigns set cost_per_click_usd_cents=100,cost_per_impression_usd_cents=50 where id=$1',[f.campaign.id]);
      await pool.query("update ads_creatives set ad_format='banner',ad_type='image',image_url='https://billing.example.test/banner.png' where id=$1",[f.creative.id]);
      const [site] = await db.insert(schema.adsPromoterWebsites).values({promoterId:f.promoter.id,url:'https://billing.example.test',domain:'billing.example.test',verificationToken:randomUUID(),verificationMethod:'dns_txt',verificationStatus:'verified',verificationExpiresAt:new Date(Date.now()+86400000),policyStatus:'approved'}).returning();
      const [slot] = await db.insert(schema.adstationSlots).values({websiteId:site.id,promoterId:f.promoter.id,name:'Billing fixture',slotTagId:'cf-slot-plan0092-billing',slotType:'network',format:'banner',lifecycleStatus:'active',installationStatus:'verified',allowedAdTypes:'["text"]',isActive:true}).returning();
      const opportunityId=randomUUID(), clearingPriceMicros=reservePriceMicrosForModel(model);
      const priceNanos=eventPriceNanos(model,clearingPriceMicros).toString();
      const decision={requestId:opportunityId,winnerCampaignId:f.campaign.id,winnerCreativeId:f.creative.id,clearingPriceMicros,billingPriceNanos:priceNanos,policyVersion:'plan0092-fixture',bidderGroupingMode:'advertiser',tieSeed:'fixture',candidateCount:1,eligibleGroupCount:1,evaluatedCandidates:[],excludedCandidates:[]};
      process.env.ADS_IMPRESSION_SIGNING_KEY = 'plan0103-local-impression-signing-key';
      const visitorIp = '192.0.2.10';
      const tokens = new ImpressionTokenService();
      const paid={...body,ipHash:tokens.hashIp(visitorIp),serveBefore:new Date(Date.now()+9000).toISOString(),opportunityId,campaignId:f.campaign.id,creativeId:f.creative.id,submissionId:f.campaign.currentSubmissionId,contentRevision:f.campaign.contentRevision,promoterId:f.promoter.id,websiteId:site.id,slotId:slot.id,policyVersion:decision.policyVersion,priceNanos,clearingPriceMicros,decision};
      const client = new OpportunityClient(new ConfigService({ BILLING_API_URL:origin, INTERNAL_ECOSYSTEM_KEY:key }));
      const ledgerBefore=(await pool.query('select count(*)::int n from billing_transactions')).rows[0].n;
      await pool.query("update users set status='SUSPENDED' where id=$1",[f.publisher]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_ACCOUNT_INELIGIBLE'} satisfies Partial<OpportunityConflictError>);
      expect((await pool.query('select count(*)::int n from ads_opportunity_reservations where opportunity_id=$1',[opportunityId])).rows[0].n).toBe(0);
      await pool.query("update users set status='ACTIVE' where id=$1",[f.publisher]);
      await pool.query("update ads_creatives set ad_format='card' where id=$1",[f.creative.id]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_FORMAT_MISMATCH'});
      await pool.query("update ads_creatives set ad_format='banner', review_status='pending' where id=$1",[f.creative.id]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_NOT_APPROVED'});
      await pool.query("update ads_creatives set review_status='approved' where id=$1",[f.creative.id]);
      await expect(client.reserve({...paid,creativeId:randomUUID(),decision:{...decision,winnerCreativeId:'different'}})).rejects.toMatchObject({reasonCode:'BILLING_DECISION_BINDING_MISMATCH'});
      const missingCreativeId = randomUUID();
      await expect(client.reserve({...paid,creativeId:missingCreativeId,decision:{...decision,winnerCreativeId:missingCreativeId}})).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_NOT_FOUND'});
      await pool.query("update ads_creatives set status='paused' where id=$1",[f.creative.id]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_INACTIVE'});
      await pool.query("update ads_creatives set status='active' where id=$1",[f.creative.id]);
      await pool.query('update ads_creative_stacks set archived=true where id=$1',[f.creative.adStackId]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_STACK_ARCHIVED'});
      await pool.query('update ads_creative_stacks set archived=false where id=$1',[f.creative.adStackId]);
      process.env.CREATIVE_VIDEO_AUTHORING_ENABLED='false';
      await pool.query("update ads_creatives set ad_type='video' where id=$1",[f.creative.id]);
      await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode:'BILLING_CREATIVE_VIDEO_DISABLED'});
      await pool.query("update ads_creatives set ad_type='image' where id=$1",[f.creative.id]);
      for (const [stored, reasonCode] of [['[]','BILLING_CREATIVE_TYPE_NOT_ALLOWED'],['["text"]','BILLING_CREATIVE_TYPE_NOT_ALLOWED'],['{','BILLING_CREATIVE_SLOT_TYPES_INVALID'],['["IMAGE"]','BILLING_CREATIVE_SLOT_TYPES_INVALID']]) {
        await pool.query('update adstation_slots set allowed_ad_types=$1 where id=$2',[stored,slot.id]);
        await expect(client.reserve(paid)).rejects.toMatchObject({reasonCode});
      }
      await pool.query('update adstation_slots set allowed_ad_types=null where id=$1',[slot.id]);
      expect((await pool.query('select count(*)::int n from ads_opportunity_reservations where opportunity_id=$1',[opportunityId])).rows[0].n).toBe(0);
      expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(ledgerBefore);
      paid.serveBefore=new Date(Date.now()+9000).toISOString();
      const imageUrl = 'https://billing.example.test/rectangle.webp';
      const [asset] = await db.insert(schema.adsMediaAssets).values({
        ownerId: f.campaign.advertiserId, storageKey: randomUUID(), cdnUrl: imageUrl,
        width: 336, height: 280, bytes: 80_000, mimeType: 'image/webp', sha256: 'a'.repeat(64), status: 'ready',
      }).returning();
      await pool.query("update ads_creatives set ad_format='card', media_asset_id=$1, image_url=$2 where id=$3",[asset.id,imageUrl,f.creative.id]);
      await pool.query("update adstation_slots set format='general', allowed_preset_ids=$1 where id=$2",['["large_square"]',slot.id]);
      const general = {...paid, selectedImageUrl:imageUrl};
      await expect(client.reserve(general)).rejects.toMatchObject({reasonCode:'BILLING_RENDITION_INVALID'});
      await pool.query('update adstation_slots set allowed_preset_ids=$1 where id=$2',['["medium_rectangle"]',slot.id]);
      await expect(client.reserve({...general, selectedImageUrl:'https://billing.example.test/substituted.webp'})).rejects.toMatchObject({reasonCode:'BILLING_RENDITION_INVALID'});
      Object.assign(paid, general, {serveBefore:new Date(Date.now()+9000).toISOString()});
      const first=await request(paid,key);
      expect(first.status).toBe(201);
      await first.arrayBuffer(); // Model a lost acknowledgement and replay the same binding.
      const repeated=await request(paid,key);
      expect(repeated.status).toBe(201);
      const held=(await repeated.json() as any).data;
      expect(held).toMatchObject({authorityVersion:'opportunity-v1',opportunityId,state:'HELD'});
      await expect(client.reserve({...paid, visitorKey:'b'.repeat(64)})).rejects.toMatchObject({reasonCode:'BILLING_IDENTITY_CONFLICT'});
      const issue=()=>fetch(`${base}/${held.reservationId}/issue`,{method:'POST',headers:{'Content-Type':'application/json','x-internal-key':key},body:JSON.stringify({bindingFingerprint:held.bindingFingerprint}),signal:AbortSignal.timeout(5000)});
      const issued=await issue();
      expect(issued.status).toBe(201);
      const result=(await issued.json() as any).data;
      expect(result.receipt.state).toBe('ISSUED');
      const replay=await issue();
      expect(replay.status).toBe(201);
      expect((await replay.json() as any).data.serveId).toBe(result.serveId);
      expect((await pool.query('select count(*)::int n from ads_opportunity_reservations where opportunity_id=$1',[opportunityId])).rows[0].n).toBe(1);
      expect((await pool.query('select count(*)::int n from ads_serves where request_id=$1',[opportunityId])).rows[0].n).toBe(1);
      const trace = await new AdsOperationsService(db).getAuctionDecision(opportunityId);
      expect(trace?.billingPriceNanos).toBe(priceNanos);
      expect(trace?.pricingBreakdown).toMatchObject({
        billingUnit:model === 'cpc' ? 'eligible click' : 'eligible viewable impression',reservedNanos:priceNanos,reservationState:'ISSUED',
        clearingBasis:'single_group_reserve',pctrBasisPoints:'150',claimId:null,settledDebitCents:null,publisherEarningsCents:null,
      });
      process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION = 'plan0103-local-assessment';
      const evidence = new EvidenceService(db, client);
      const delivery = new DeliveryService(db, tokens, new AuctionEngineService(), new FraudRulesService(), client, evidence);
      const token = tokens.generateToken({ servedId: result.serveId, placementId: HOUSE_PLACEMENT_UUID,
        campaignId: f.campaign.id, creativeId: f.creative.id, promoterId: f.promoter.id, ipHash: paid.ipHash });
      const settle = (requestId = randomUUID(), cutoff = new Date()) => f.svc.settle(f.campaign.id, requestId, cutoff);
      expect((await settle()).billedUsdCents).toBe(0);
      expect(await delivery.logInteraction({ impToken: token, type: 'click',
        userAgent: 'Mozilla/5.0 Chrome/130' })).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 350));
      const event = await delivery.logInteraction({ impToken: token, type: model === 'cpc' ? 'click' : 'viewable_impression',
        userAgent: 'Mozilla/5.0 Chrome/130', clientIp: visitorIp, visibleRatio: 0.8, durationSeconds: 2 });
      if (!event) throw new Error('Signed pricing event was not recorded');
      expect(event).toMatchObject({isValid:true,verificationVersion:2,financialEligibility:'pending'});
      const worker = new AdOpportunityWorker(db, new AdOpportunityService(db), f.svc, new CampaignEscrowService(db));
      const workerWarning = jest.spyOn((worker as any).logger, 'warn');
      await worker.tick();
      expect(workerWarning).not.toHaveBeenCalled();
      await client.claim(held.reservationId, event.id);
      expect((await settle()).billedUsdCents).toBe(0);
      const actor = randomUUID();
      await pool.query("insert into users(id,email,status) values($1,'assessment@example.test','ACTIVE')",[actor]);
      const assessment = { requestId: randomUUID(), outcome: 'eligible' as const,
        policyVersion: process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION, reasonCodes: ['VERIFIED_EVENT'] };
      await expect(evidence.assess(event.id, owner, assessment)).rejects.toThrow('Owners cannot assess');
      await evidence.assess(event.id, actor, assessment);
      await pool.query("update adstation_slots set is_active=false where id=$1",[slot.id]);
      expect((await settle()).billedUsdCents).toBe(0);
      await pool.query("update adstation_slots set is_active=true where id=$1",[slot.id]);
      if (model === 'cpc') {
        await pool.query("update ads_campaigns set status='paused' where id=$1",[f.campaign.id]);
        await pool.query("update ads_campaign_escrows set release_pending=true where campaign_id=$1",[f.campaign.id]);
      }
      const requestId = randomUUID(), cutoff = new Date();
      const settleTarget = (eventId: string) => f.svc.settle(f.campaign.id, requestId, cutoff, eventId);
      await expect(f.svc.settle(f.campaign.id, randomUUID(), cutoff, randomUUID())).rejects.toThrow('not ready to settle');
      const receipts = await Promise.all([settleTarget(event.id), settleTarget(event.id)]);
      await expect(settleTarget(randomUUID())).rejects.toThrow('Settlement request is bound');
      const cents = model === 'cpc' ? 10 : 0;
      expect(receipts.map(receipt => receipt.billedUsdCents)).toEqual([cents, cents]);
      expect(receipts.filter(receipt => receipt.replayed)).toHaveLength(1);
      expect((await pool.query('select settled_at from ads_opportunity_reservations where id=$1',[held.reservationId])).rows[0].settled_at).toBeInstanceOf(Date);
      expect((await pool.query("select amount_usd_cents,status from billing_transactions where type in ('ads_spend','ads_earning') order by type::text")).rows)
        .toEqual(model === 'cpc' ? [{amount_usd_cents:5,status:'pending'},{amount_usd_cents:10,status:'completed'}] : []);
      expect((await pool.query('select carry_nanos from ads_settlement_carries')).rows[0].carry_nanos)
        .toBe(model === 'cpm' ? priceNanos : '0');
      expect((await pool.query('select count(*)::int n from ads_settlement_claims where serve_id=$1',[result.serveId])).rows[0].n).toBe(1);
      const settledTrace = await new AdsOperationsService(db).getAuctionDecision(opportunityId);
      expect(settledTrace?.pricingBreakdown).toMatchObject({
        claimId: expect.any(String), claimPriceNanos: priceNanos, batchStatus: 'completed',
        settledDebitCents: model === 'cpc' ? '10' : null,
        publisherEarningsCents: model === 'cpc' ? '5' : null,
      });
      expect((await settle()).billedUsdCents).toBe(0);
    } finally {
      await app.close();
      process.env = previousEnv;
    }
  }, 30_000);
  test('PLAN0079 owner-scoped embed readiness HTTP is non-writing and refuses foreign or missing profiles',async()=>{
    const [promoter]=await db.insert(schema.adsPromoters).values({userId:owner,type:'WEBSITE'}).returning();
    const [website]=await db.insert(schema.adsPromoterWebsites).values({promoterId:promoter.id,url:'https://example.test',domain:'example.test',verificationToken:randomUUID(),verificationMethod:'dns_txt',verificationStatus:'verified',verificationExpiresAt:new Date(Date.now()+86400000),policyStatus:'testing'}).returning();
    const [slot]=await db.insert(schema.adstationSlots).values({websiteId:website.id,promoterId:promoter.id,name:'Diagnostic slot',slotTagId:'cf-slot-diagnostic',slotType:'network',format:'banner',lifecycleStatus:'testing',isActive:true}).returning();
    const other=randomUUID(),missingProfile=randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'other@example.test','ACTIVE'),($2,'missing@example.test','ACTIVE')",[other,missingProfile]);
    await db.insert(schema.adsPromoters).values({userId:other,type:'WEBSITE'});
    const service=new AdstationService(db),promoters=new PromotersService(db);
    @Module({controllers:[AdstationController,PublisherInventoryController],providers:[{provide:PublisherSlotsService,useValue:new PublisherSlotsService(db)},{provide:AdstationService,useValue:service},{provide:PromotersService,useValue:promoters},{provide:SetupChecksService,useValue:{}}]})class LocalDiagnosticModule{}
    const jwt=new JwtService({secret:'plan0079-local-http-only-key'}),grants={rolesFor:()=>[]} as unknown as AdsStaffGrants;
    const app=await NestFactory.create(LocalDiagnosticModule,{logger:false});app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,grants));await app.listen(0,'127.0.0.1');
    const get=async(actor:string|undefined,id=slot.id,namespace='adstation')=>{const res=await fetch((await app.getUrl())+'/api/v1/'+namespace+'/slots/'+id+'/embed',{headers:actor?{Authorization:'Bearer '+jwt.sign({sub:actor,email:'fixture@example.test',type:'access'},{expiresIn:'2m'})}:{},signal:AbortSignal.timeout(10000)});return {status:res.status,body:await res.json() as any};};
    const counts=async()=>{const result:any={};for(const table of ['ads_promoters','ads_serves','ads_interactions','billing_wallets','billing_transactions'])result[table]=(await pool.query('select count(*)::int n from '+table)).rows[0].n;return result;};
    try{const before=await counts();expect((await get(undefined)).status).toBe(401);expect((await get(other)).status).toBe(404);expect((await get(missingProfile)).status).toBe(404);expect((await get(owner,randomUUID())).status).toBe(404);expect((await get(owner,'not-a-uuid')).status).toBe(400);const response=await get(owner);expect(response.status).toBe(200);const canonical=await get(owner,slot.id,'publisher');expect(canonical.status).toBe(200);expect(canonical.body.data.slotSnippet).toBe(response.body.data.slotSnippet);expect((await get(other,slot.id,'publisher')).status).toBe(404);expect((await get(undefined,slot.id,'publisher')).status).toBe(401);expect(response.body.data.slotSnippet).toContain('data-cf-consent="unknown"');expect(response.body.data.slotSnippet).not.toContain('<script');expect(response.body.data.sdkSnippet).toContain('/api/v1/delivery/embed.js');expect(response.body.data.consentInstructions).toContain('genuine visitor consent');expect(response.body.data.deliveryReadiness.blockers).toContain('WEBSITE_APPROVAL_REQUIRED');expect(response.body.data.deliveryReadiness.remainingChecks).not.toContain('MEASUREMENT_CONSENT');expect(await counts()).toEqual(before);expect((await pool.query('select policy_status from ads_promoter_websites')).rows[0].policy_status).toBe('testing');expect((await pool.query('select lifecycle_status from adstation_slots')).rows[0].lifecycle_status).toBe('testing');}
    finally {
      await app.close();
    }
    const beforeSlots=await pool.query('select id, slot_tag_id from adstation_slots order by id');
    const directDeal=await service.createDirectCampaign(promoter.id,{websiteId:website.id,slotId:slot.id,clientName:'Fixture advertiser',campaignTitle:'Fixture direct campaign',destinationUrl:'https://advertiser.example.test'});
    expect(directDeal.slotId).toBe(slot.id);
    expect((await pool.query('select id, slot_tag_id from adstation_slots order by id')).rows).toEqual(beforeSlots.rows);
  });

  test('PLAN0080 website policy HTTP enforces staff, expiry, atomic history and concurrent revisions',async()=>{
    const staff=randomUUID();await pool.query("insert into users(id,email,status) values($1,'staff@example.test','ACTIVE')",[staff]);
    const [promoter]=await db.insert(schema.adsPromoters).values({userId:owner,type:'WEBSITE'}).returning();
    const [site]=await db.insert(schema.adsPromoterWebsites).values({promoterId:promoter.id,url:'https://publisher.example.test',domain:'publisher.example.test',verificationToken:randomUUID(),verificationMethod:'dns_txt',verificationStatus:'verified',verificationExpiresAt:new Date(0),policyStatus:'testing'}).returning();
    @Module({controllers:[AdsOperationsController],providers:[{provide:AdsOperationsService,useValue:new AdsOperationsService(db)},{provide:PromotersService,useValue:new PromotersService(db)},{provide:SetupChecksService,useValue:{}}]})class WebsitePolicyModule{}
    const jwt=new JwtService({secret:'plan0080-local-test-key'}),grants={rolesFor:(id:string)=>id===staff?['ads_admin']:[]}as unknown as AdsStaffGrants;
    const app=await NestFactory.create(WebsitePolicyModule,{logger:false});app.setGlobalPrefix('api/v1');app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,grants));await app.listen(0,'127.0.0.1');
    const post=async(actor:string|undefined,decision='approved',id=site.id,reason='Local fixture suitability review',namespace='adstation/admin')=>{const response=await fetch((await app.getUrl())+'/api/v1/'+namespace+'/websites/'+id+'/policy',{method:'POST',headers:{'Content-Type':'application/json',...(actor?{Authorization:'Bearer '+jwt.sign({sub:actor,email:'fixture@example.test',type:'access'},{expiresIn:'2m'})}:{})},body:JSON.stringify({decision,reason}),signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json()as any};};
    const read=async()=>({site:(await pool.query('select policy_status,policy_revision from ads_promoter_websites where id=$1',[site.id])).rows[0],history:(await pool.query('select from_state,to_state,actor_id from ads_supply_state_history where entity_id=$1',[site.id])).rows});
    try{
      expect((await post(undefined)).status).toBe(401);expect((await post(owner)).status).toBe(403);expect((await post(staff,'invalid')).status).toBe(400);expect((await post(staff,'approved','invalid-uuid')).status).toBe(400);expect((await post(staff,'approved',site.id,'x'.repeat(1001))).status).toBe(400);expect((await post(staff)).status).toBe(400);expect((await read()).history).toHaveLength(0);
      await pool.query("update ads_promoter_websites set verification_expires_at=now()+interval '1 day' where id=$1",[site.id]);
      await pool.query("create function fail_website_history() returns trigger language plpgsql as $$ begin raise exception 'injected history failure'; end $$");await pool.query('create trigger fail_website_history before insert on ads_supply_state_history for each row execute function fail_website_history()');
      try{expect((await post(staff)).status).toBe(500);const r=await read();expect(r.site.policy_status).toBe('testing');expect(r.site.policy_revision).toBe(1);expect(r.history).toHaveLength(0);}finally{await pool.query('drop trigger fail_website_history on ads_supply_state_history');await pool.query('drop function fail_website_history()');}
      expect((await post(owner,'approved',site.id,'Local fixture suitability review','admin/ads')).status).toBe(403);
      const approved=await post(staff,'approved',site.id,'Local fixture suitability review','admin/ads');expect(approved.status).toBe(201);expect(approved.body.data.policyStatus).toBe('approved');expect((await read()).history).toEqual([{from_state:'testing',to_state:'approved',actor_id:staff}]);
      const concurrent=await Promise.all([post(staff,'testing'),post(staff,'approved')]);expect(concurrent.map(r=>r.status)).toEqual([201,201]);expect(new Set(concurrent.map(r=>r.body.data.policyRevision)).size).toBe(2);const final=await read();expect(final.site.policy_revision).toBe(4);expect(final.history).toHaveLength(3);expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(0);
    }finally{await app.close();}
  });

  test('parallel account initialization creates one profile and one default consent', async () => {
    const service = new PromotersService(db);
    const types = ['WEBSITE', 'MOBILE_APP', 'INDIVIDUAL', 'INDIVIDUAL', 'WEBSITE', 'MOBILE_APP', 'INDIVIDUAL'] as const;
    const results = await Promise.all(types.map(type => service.getOrCreatePromoter(owner, type)));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect((await pool.query('select count(*)::int count from ads_promoters')).rows[0].count).toBe(1);
    expect((await pool.query('select consent_given from ads_reels_consents')).rows).toEqual([{ consent_given: 0 }]);
    await pool.query('update ads_reels_consents set consent_given=1');
    await Promise.all(types.map(type => service.getOrCreatePromoter(owner, type, 'replacement')));
    expect((await pool.query('select consent_given from ads_reels_consents')).rows).toEqual([{ consent_given: 1 }]);
    expect((await pool.query('select type,display_name from ads_promoters')).rows[0]).toEqual({ type: results[0].type, display_name: 'CrimFig Promoter' });
  });
  test('consent initialization failure rolls back a new promoter and a retry recovers', async () => {
    await pool.query("create function reject_consent() returns trigger language plpgsql as $$ begin raise exception 'injected consent failure'; end $$");
    await pool.query('create trigger fail_consent before insert on ads_reels_consents for each row execute function reject_consent()');
    try {
      await expect(new PromotersService(db).getOrCreatePromoter(owner)).rejects.toThrow();
      expect((await pool.query('select count(*)::int count from ads_promoters')).rows[0].count).toBe(0);
    } finally {
      await pool.query('drop trigger fail_consent on ads_reels_consents');
      await pool.query('drop function reject_consent()');
    }
    await new PromotersService(db).getOrCreatePromoter(owner);
    expect((await pool.query('select count(*)::int count from ads_reels_consents')).rows[0].count).toBe(1);
  });
  const fx = () => ({getUsdToNgnRate:async()=>({rateId,rate:100}),convertUsdCentsToNgn:async(cents:number)=>({ngnKobo:cents*100})});
  const provider = () => ({paymentDomain:()=> 'test',assertFundingConfiguration:jest.fn(),initializeTransaction:jest.fn(async (input:any)=>({reference:input.reference,authorization_url:'https://checkout.paystack.com/fixture',access_code:'fixture'}))});
  const service = (psp:any=provider()) => new WalletService(db,fx() as any,psp);
  async function intent(cents=500) {
    const [row]=await db.insert(schema.billingTransactions).values({userId:owner,type:'wallet_fund',status:'pending',provider:'paystack',reference:'fixture-'+randomUUID(),amountUsdCents:cents,amountNgnKobo:cents*100,exchangeRateId:rateId,metadata:JSON.stringify({fundingVersion:2,expectedEmail:'owner@example.test',saveCard:false})}).returning();return row;
  }
  const proof = (row:any) => ({reference:row.reference,status:'success',currency:'NGN',domain:'test',amount:row.amountNgnKobo,metadata:{transactionId:row.id,userId:owner},customer:{email:'owner@example.test'}});
  (process.env.PLAN0009_REDIS_URL ? test : test.skip)('real Redis OAuth codes enforce PKCE, scopes, atomic redemption, expiry and replica shutdown', async () => {
    const verifier = 'a'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
    const registration = { clientId: 'public-fixture', name: 'Public fixture', redirectUris: JSON.stringify(['https://app.example.test/callback']), allowedScopes: 'openid profile email' };
    await db.insert(schema.oauthClients).values(registration);
    const request = { client_id: registration.clientId, redirect_uri: 'https://app.example.test/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'openid' };
    const replicas = [new OAuthService(db, new JwtService()), new OAuthService(db, new JwtService())];
    try {
      for (const replica of replicas) {
        let ready = false;
        for (let attempt = 0; attempt < 30; attempt++) { if (await replica.pingRedis()) { ready = true; break; } await new Promise(done => setTimeout(done, 50)); }
        expect(ready).toBe(true);
      }
      await expect(replicas[0].validateAuthorization({ ...request, code_challenge_method: 'plain' })).rejects.toThrow('S256');
      await expect(replicas[0].validateAuthorization({ ...request, code_challenge: undefined })).rejects.toThrow('S256');
      await expect(replicas[0].validateAuthorization({ ...request, scope: 'openid billing:write' })).rejects.toThrow('scope');
      await expect(replicas[0].validateAuthorization({ ...request, redirect_uri: 'https://evil.example.test/callback' })).rejects.toThrow('redirect_uri');
      await expect(replicas[0].validateAuthorization({ ...request, response_type: 'token' })).rejects.toThrow('response_type');
      const code = await replicas[0].generateAuthCode(owner, request);
      await expect(replicas[1].exchangeCodeForTokens(code, request.client_id, request.redirect_uri, 'b'.repeat(64))).rejects.toThrow('Invalid or expired');
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => replicas[index % 2].exchangeCodeForTokens(code, request.client_id, request.redirect_uri, verifier)));
      const winners = results.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      expect(winners[0].value).toMatchObject({ scope: 'openid', expiresIn: 300, token_type: 'Bearer' });
      expect(winners[0].value.refreshToken).toBeUndefined();
      const token = winners[0].value.accessToken;
      expect(new JwtService().decode(token)).toMatchObject({ type: 'oauth_access', aud: request.client_id, scope: 'openid' });
      expect(await replicas[1].getUserInfo('Bearer ' + token)).toEqual({ sub: owner });
      expect((await pool.query('select count(*)::int count from apps')).rows[0].count).toBe(0);
      expect((await pool.query('select count(*)::int count from refresh_tokens')).rows[0].count).toBe(0);
      const fullCode = await replicas[0].generateAuthCode(owner, { ...request, scope: 'openid profile email' });
      const full = await replicas[1].exchangeCodeForTokens(fullCode, request.client_id, request.redirect_uri, verifier);
      expect(await replicas[0].getUserInfo('Bearer ' + full.accessToken)).toEqual({ sub: owner, email: 'owner@example.test', email_verified: false, locale: 'en' });
      await pool.query("update users set status='SUSPENDED' where id=$1", [owner]);
      await expect(replicas[0].getUserInfo('Bearer ' + full.accessToken)).rejects.toThrow('Account');
      await pool.query("update users set status='ACTIVE' where id=$1", [owner]);
      const expired = await replicas[0].generateAuthCode(owner, request);
      await new Promise(done => setTimeout(done, 2200));
      await expect(replicas[1].exchangeCodeForTokens(expired, request.client_id, request.redirect_uri, verifier)).rejects.toThrow('expired');
      await pool.query("update oauth_clients set is_active=false where client_id=$1", [request.client_id]);
      await expect(replicas[0].getUserInfo('Bearer ' + token)).rejects.toThrow('no longer available');
    } finally { await Promise.all(replicas.map(replica => replica.onModuleDestroy())); }
    expect(await replicas[0].pingRedis()).toBe(false);
  }, 20000);
  (process.env.PLAN0009_REDIS_URL ? test : test.skip)('real Redis OAuth confidential clients require their secret and PKCE before redemption', async () => {
    const secret = 'isolated-client-secret', verifier = 'c'.repeat(64);
    await db.insert(schema.oauthClients).values({ clientId: 'confidential-fixture', name: 'Confidential fixture', redirectUris: JSON.stringify(['https://app.example.test/callback']), clientSecretHash: await argon2.hash(secret) });
    const replica = new OAuthService(db, new JwtService());
    try {
      for (let attempt = 0; attempt < 30 && !await replica.pingRedis(); attempt++) await new Promise(done => setTimeout(done, 50));
      const request = { client_id: 'confidential-fixture', redirect_uri: 'https://app.example.test/callback', response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'openid email' };
      const code = await replica.generateAuthCode(owner, request);
      await expect(replica.exchangeCodeForTokens(code, request.client_id, request.redirect_uri, verifier)).rejects.toThrow('Client authentication');
      await expect(replica.exchangeCodeForTokens(code, request.client_id, request.redirect_uri, verifier, 'wrong')).rejects.toThrow('Client authentication');
      expect(await replica.exchangeCodeForTokens(code, request.client_id, request.redirect_uri, verifier, secret)).toMatchObject({ scope: 'openid email' });
    } finally { await replica.onModuleDestroy(); }
  }, 20000);
  (process.env.PLAN0009_PROVIDER_ENV ? test : test.skip)('real Paystack TEST hosted funding and subscription checkout with a saved-card renewal', async () => {
    const { parse } = require('dotenv');
    const config = parse(readFileSync(process.env.PLAN0009_PROVIDER_ENV!));
    if (!/^sk_test_[a-zA-Z0-9]+$/.test(config.PAYSTACK_SECRET_KEY || '') || !/^pk_test_[a-zA-Z0-9]+$/.test(config.PAYSTACK_PUBLIC_KEY || '')) throw Error('TEST-only provider keys required');
    const originalKey = process.env.PAYSTACK_SECRET_KEY, originalUrl = process.env.BILLING_WEB_URL;
    process.env.PAYSTACK_SECRET_KEY = config.PAYSTACK_SECRET_KEY;
    process.env.BILLING_WEB_URL = 'http://127.0.0.1:3019/';
    const psp = new PaystackService();
    expect(psp.paymentDomain()).toBe('test');
    let checkout = '', phase = 'funding';
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/' && checkout) { response.writeHead(302, { Location: checkout }); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end(`PLAN-0009 TEST ${phase}: provider return received. Verification runs independently against Paystack. No production account is used.`); }
    });
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(3019, '127.0.0.1', done); });
    const waitPaid = async (reference: string) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        const verified = await psp.verifyTransaction(reference);
        if (verified.status === 'success') return verified;
        await new Promise(done => setTimeout(done, 2000));
      }
      throw Error('TEST checkout was not completed within the acceptance window');
    };
    try {
      const wallet = new WalletService(db, fx() as any, psp);
      await pool.query('update users set email=$1 where id=$2', ['plan0009@example.com', owner]);
      const initialized = await wallet.initializeFunding({ userId: owner, userEmail: 'plan0009@example.com', requestId: randomUUID(), amountUsd: 5, saveCard: true });
      checkout = initialized.authorizationUrl!;
      console.log('PLAN-0009 TEST funding checkout ready: http://127.0.0.1:3019/');
      const funding = await waitPaid(initialized.reference);
      await Promise.all([wallet.verifyFunding(initialized.reference, owner), wallet.completeSuccessfulFunding(funding.metadata.transactionId, funding)]);
      expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0].balance_usd_cents).toBe(500);
      const card = (await pool.query('select id from billing_saved_cards where user_id=$1', [owner])).rows[0];
      expect(card).toBeDefined();
      const payments = new SubscriptionPaymentsService(db, fx() as any, psp);
      const subscription = await payments.initialize({ userId: owner, requestId: randomUUID(), appSlug: 'chat', planId: 'chat_pro', interval: 'monthly' });
      phase = 'subscription'; checkout = subscription.checkoutUrl!;
      console.log('PLAN-0009 TEST subscription checkout ready: reopen http://127.0.0.1:3019/');
      const paid = await waitPaid(subscription.reference);
      await Promise.all([payments.complete(subscription.reference, paid), payments.recoverReference(owner, subscription.reference)]);
      const sub = (await pool.query('select * from billing_subscriptions')).rows[0];
      await payments.consent(owner, sub.id, { requestId: randomUUID(), savedCardId: card.id, maxNgnKobo: 1_000_000, expectedPeriodEnd: sub.current_period_end.toISOString() });
      // Advance the isolated entitlement fixture, not the provider clock or production data.
      const end = new Date(Date.now() - 1000), start = new Date(end.getTime() - 30 * 86400_000);
      await pool.query('update billing_subscriptions set current_period_start=$1,current_period_end=$2,next_billing_date=$2 where id=$3', [start, end, sub.id]);
      const receipt = (await pool.query('select id,metadata from billing_transactions where reference=$1', [subscription.reference])).rows[0];
      const metadata = JSON.parse(receipt.metadata); metadata.completion = { periodStart: start.toISOString(), periodEnd: end.toISOString() };
      await pool.query('update billing_transactions set metadata=$1 where id=$2', [JSON.stringify(metadata), receipt.id]);
      await payments.renew(sub.id);
      const renewal = (await pool.query("select reference from billing_transactions where type='subscription_renewal'")).rows[0];
      await waitPaid(renewal.reference);
      await Promise.all([payments.recoverReference(owner, renewal.reference), payments.recoverReference(owner, renewal.reference)]);
      expect((await payments.entitlement(owner, 'chat')).entitled).toBe(true);
      expect((await pool.query("select count(*)::int count from billing_transactions where type='subscription_renewal' and status='completed'")).rows[0].count).toBe(1);
      expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0].balance_usd_cents).toBe(500);
      console.log('PASS: real Paystack TEST hosted funding, saved-card storage, subscription activation and one recovered authorization renewal. Actual external webhook delivery is a separate gate.');
    } finally {
      await new Promise<void>(done => server.close(() => done()));
      if (originalKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = originalKey;
      if (originalUrl === undefined) delete process.env.BILLING_WEB_URL; else process.env.BILLING_WEB_URL = originalUrl;
    }
  }, 660000);
  (process.env.PLAN0009_PROVIDER_ENV ? test : test.skip)('real Paystack TEST transfer binds the verified recipient and quoted net payout and dispatches once', async () => {
    const config = require('dotenv').parse(readFileSync(process.env.PLAN0009_PROVIDER_ENV!));
    if (!/^sk_test_[a-zA-Z0-9]+$/.test(config.PAYSTACK_SECRET_KEY || '')) throw Error('TEST-only provider key required');
    const previous = process.env.PAYSTACK_SECRET_KEY; process.env.PAYSTACK_SECRET_KEY = config.PAYSTACK_SECRET_KEY;
    try {
      const psp = new PaystackService(); expect(psp.paymentDomain()).toBe('test');
      // The disposable ledger can disappear while a provider request still awaits OTP.
      // Never create a replacement payout until earlier TEST requests are resolved.
      let historyComplete = false;
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(`https://api.paystack.co/transfer?perPage=100&page=${page}`, {
          headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        const history = await response.json() as any;
        if (!response.ok || history.status !== true || !Array.isArray(history.data)) throw Error('Cannot establish prior TEST transfer state; no new payout created');
        for (const transfer of history.data) {
          if (transfer.domain !== 'test') throw Error('Unexpected provider domain; no new payout created');
          if (String(transfer.reference).startsWith('wd_') && transfer.reason === 'CrimFig Withdrawal' &&
            !['success', 'failed', 'reversed', 'abandoned', 'rejected'].includes(transfer.status)) {
            throw Error(`Earlier TEST payout remains unresolved: ${transfer.reference}. Recover that request before starting another acceptance run.`);
          }
        }
        if (history.data.length < 100) { historyComplete = true; break; }
      }
      if (!historyComplete) throw Error('TEST transfer history exceeded audit bound; no new payout created');
      const resolved = await psp.resolveAccount('0000000000', '057');
      expect(resolved.account_number).toBe('0000000000'); expect(resolved.account_name).toBeTruthy();
      const recipient = await psp.createTransferRecipient({ name: resolved.account_name, accountNumber: resolved.account_number, bankCode: '057' });
      expect(recipient.recipient_code).toMatch(/^RCP_/);
      const [bank] = await db.insert(schema.billingBankAccounts).values({ userId: owner, bankName: 'Paystack TEST Zenith', bankCode: '057',
        accountNumber: resolved.account_number, accountName: resolved.account_name, isVerified: true, recipientCode: recipient.recipient_code }).returning();
      await pool.query('update billing_exchange_rates set raw_main_response=$1,fetched_at=now()', [JSON.stringify({ result: 'success', base_code: 'USD', rates: { NGN: 100 }, time_last_update_unix: Math.floor(Date.now() / 1000) })]);
      await db.insert(schema.billingWallets).values({ userId: owner, balanceUsdCents: 1500 }); // Disposable ledger fixture, no real-money balance.
      const ledger = new WithdrawalLedgerService(db, psp, new ExchangeRateService(db));
      const requestId = randomUUID(), quote = await ledger.quote(owner, requestId, bank.id, 500);
      const reserved = await ledger.reserve(owner, requestId, bank.id, 500, quote.quoteId);
      const sends = jest.spyOn(psp, 'initiateTransfer');
      const dispatcher = new WithdrawalDispatchService(ledger, psp);
      await Promise.all(Array.from({ length: 3 }, () => dispatcher.dispatch(owner, reserved.reference)));
      let result, approvalAnnounced = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        result = await dispatcher.recover(owner, reserved.reference);
        if (result.status === 'completed') break;
        if (result.confirmation === 'operator_approval_required' && !approvalAnnounced) {
          console.log(`Paystack TEST operator approval needed: reference=${reserved.reference} netNGN=${(quote.netKobo / 100).toFixed(2)}. Approve this exact TEST transfer in Paystack; do not disable OTP.`);
          approvalAnnounced = true;
        }
        await new Promise(done => setTimeout(done, 3000));
      }
      expect(result?.status).toBe('completed'); expect(sends).toHaveBeenCalledTimes(1);
      expect(sends.mock.calls[0][0]).toMatchObject({ amountKobo: quote.netKobo, recipientCode: recipient.recipient_code, reference: reserved.reference });
      await Promise.all([dispatcher.recover(owner, reserved.reference), dispatcher.recover(owner, reserved.reference)]);
      expect((await pool.query('select balance_usd_cents,locked_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0]).toEqual({ balance_usd_cents: 1000, locked_usd_cents: 0 });
      expect(sends).toHaveBeenCalledTimes(1);
      console.log('PASS: real Paystack TEST recipient resolution, net-payout transfer and GET recovery completed once. Paystack TEST transfers only return success; failure/reversal logic uses separately labelled signed fixtures.');
    } finally { if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previous; }
  }, 420000);
  test.each(['before-commit', 'after-commit'])('OS process termination and service restart preserve funding exactly once: %s', async phase => {
    const row = await intent();
    if (phase === 'before-commit') {
      await pool.query("create function pause_crash_receipt() returns trigger language plpgsql as $$ begin perform pg_sleep(20); return new; end $$");
      await pool.query('create trigger pause_crash_receipt before update on billing_transactions for each row execute function pause_crash_receipt()');
    }
    const child = spawn(process.execPath, [resolve(__dirname, '../../../scripts/plan0009-funding-crash-child.cjs')], {
      env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    const committed = new Promise<void>((done, reject) => {
      child.once('message', (message: any) => message.committed ? done() : reject(Error('Crash fixture child failed')));
      child.once('error', reject);
    });
    // A pre-commit child is killed before it can acknowledge. Observe errors without
    // treating absence of an acknowledgement as successful completion.
    void committed.catch(() => {});
    child.send!({ transactionId: row.id, proof: proof(row) });
    try {
      if (phase === 'before-commit') {
        let paused = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await pool.query("select 1 from pg_stat_activity where application_name='plan0009-funding-crash-child' and wait_event='PgSleep'");
          if (activity.rowCount) { paused = true; break; }
          await new Promise(done => setTimeout(done, 50));
        }
        expect(paused).toBe(true);
      } else {
        await Promise.race([committed, new Promise((_, reject) => setTimeout(() => reject(Error('Child commit timed out')), 6000))]);
      }
    } finally {
      child.kill('SIGKILL');
      await exited;
      if (phase === 'before-commit') {
        await pool.query('drop trigger pause_crash_receipt on billing_transactions');
        await pool.query('drop function pause_crash_receipt()');
      }
    }
    const stored = (await pool.query('select status from billing_transactions where id=$1', [row.id])).rows[0];
    expect(stored.status).toBe(phase === 'before-commit' ? 'pending' : 'completed');
    if (phase === 'before-commit') expect((await pool.query('select count(*)::int count from billing_wallets')).rows[0].count).toBe(0);
    await Promise.all([service().completeSuccessfulFunding(row.id, proof(row)), service().completeSuccessfulFunding(row.id, proof(row))]);
    expect((await pool.query('select balance_usd_cents,version from billing_wallets')).rows).toEqual([{ balance_usd_cents: 500, version: 1 }]);
  }, 20000);
  test('subscription checkout race initializes once and webhook/recovery completion grants one paid period', async () => {
    const psp: any = provider();
    const payments = () => new SubscriptionPaymentsService(db, fx() as any, psp);
    const input = { userId: owner, requestId: randomUUID(), appSlug: 'chat', planId: 'chat_pro', interval: 'monthly' as const };
    const results = await Promise.all(Array.from({length: 4}, () => payments().initialize(input)));
    expect(psp.initializeTransaction).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(row => row.reference)).size).toBe(1);
    const row = (await pool.query("select * from billing_transactions where type='subscription_charge'")).rows[0];
    const data = { reference: row.reference, status: 'success', currency: 'NGN', domain: 'test', amount: row.amount_ngn_kobo,
      customer: { email: 'owner@example.test' }, metadata: { userId: owner, transactionId: row.id } };
    psp.verifyTransaction = async () => data;
    await Promise.all([payments().complete(row.reference, data), payments().recover(owner, input.requestId), payments().complete(row.reference, data)]);
    expect((await pool.query('select count(*)::int count from billing_subscriptions')).rows[0].count).toBe(1);
    expect((await payments().entitlement(owner, 'chat')).entitled).toBe(true);
    expect((await pool.query('select count(*)::int count from billing_wallets')).rows[0].count).toBe(0);
    await expect(payments().initialize({ ...input, requestId: randomUUID() })).rejects.toThrow('existing paid period');
    await expect(payments().initialize({ ...input, planId: 'chat_business' })).rejects.toThrow('already bound');
    expect(psp.initializeTransaction).toHaveBeenCalledTimes(1);
    expect((await pool.query('select cancel_at_period_end from billing_subscriptions')).rows[0].cancel_at_period_end).toBe(true);
  }, 30000);
  test('ambiguous subscription checkout is not resent by another service instance', async () => {
    const psp: any = provider(); psp.initializeTransaction.mockRejectedValue(Error('ack lost'));
    const input = { userId: owner, requestId: randomUUID(), appSlug: 'chat', planId: 'chat_pro', interval: 'annual' as const };
    await expect(new SubscriptionPaymentsService(db,fx() as any,psp).initialize(input)).rejects.toThrow('unconfirmed');
    const recovered = await new SubscriptionPaymentsService(db,fx() as any,psp).initialize(input);
    expect(recovered.checkoutUrl).toBeNull(); expect(recovered.status).toBe('pending');
    expect(psp.initializeTransaction).toHaveBeenCalledTimes(1);
    await expect(new SubscriptionPaymentsService(db,fx() as any,psp).initialize({...input,requestId:randomUUID()})).rejects.toThrow('Recover');
  });
  test('subscription receipt failure rolls activation back and bad provider proof cannot activate', async () => {
    const psp: any = provider(); const svc = new SubscriptionPaymentsService(db,fx() as any,psp);
    await svc.initialize({userId:owner,requestId:randomUUID(),appSlug:'chat',planId:'chat_pro',interval:'monthly'});
    const row=(await pool.query("select * from billing_transactions where type='subscription_charge'")).rows[0];
    const data={reference:row.reference,status:'success',currency:'NGN',domain:'test',amount:row.amount_ngn_kobo,
      customer:{email:'owner@example.test'},metadata:{userId:owner,transactionId:row.id}};
    for(const changed of [{amount:1},{domain:'live'},{customer:{email:'foreign@example.test'}},{metadata:{userId:randomUUID(),transactionId:row.id}}]) {
      await expect(svc.complete(row.reference,{...data,...changed})).rejects.toThrow('does not match');
    }
    await pool.query("create function reject_sub_receipt() returns trigger language plpgsql as $$ begin if new.status='completed' then raise exception 'injected receipt failure'; end if; return new; end $$");
    await pool.query('create trigger fail_sub_receipt before update on billing_transactions for each row execute function reject_sub_receipt()');
    try { await expect(svc.complete(row.reference,data)).rejects.toThrow(); expect((await pool.query('select count(*)::int count from billing_subscriptions')).rows[0].count).toBe(0); }
    finally {await pool.query('drop trigger fail_sub_receipt on billing_transactions');await pool.query('drop function reject_sub_receipt()');}
    await svc.complete(row.reference,data);expect((await svc.entitlement(owner,'chat')).entitled).toBe(true);
  });
  async function renewableSubscription(psp: any, maximum = 100000) {
    const svc = new SubscriptionPaymentsService(db,fx() as any,psp);
    const input={userId:owner,requestId:randomUUID(),appSlug:'chat',planId:'chat_pro',interval:'monthly' as const};
    const initial=await svc.initialize(input);
    const row=(await pool.query('select * from billing_transactions where reference=$1',[initial.reference])).rows[0];
    await svc.complete(row.reference,{reference:row.reference,status:'success',currency:'NGN',domain:'test',amount:row.amount_ngn_kobo,
      customer:{email:'owner@example.test'},metadata:{userId:owner,transactionId:row.id}});
    const sub=(await pool.query('select * from billing_subscriptions')).rows[0];
    const card=randomUUID();await pool.query("insert into billing_saved_cards(id,user_id,provider,provider_token,last4,exp_month,exp_year,billing_email) values($1,$2,'paystack','AUTH_fixture','4242','12','2099','owner@example.test')",[card,owner]);
    const consent={requestId:randomUUID(),savedCardId:card,maxNgnKobo:maximum,expectedPeriodEnd:sub.current_period_end.toISOString()};
    await svc.consent(owner,sub.id,consent);
    // Advance only this synthetic paid generation; preserve its receipt-to-period equality.
    const end=new Date(Date.now()-1000),start=new Date(end.getTime()-30*86400000);
    await pool.query('update billing_subscriptions set current_period_start=$1,current_period_end=$2,next_billing_date=$2 where id=$3',[start,end,sub.id]);
    const metadata=JSON.parse(row.metadata);metadata.completion={periodStart:start.toISOString(),periodEnd:end.toISOString()};
    const receipt=(await pool.query('select metadata from billing_transactions where id=$1',[row.id])).rows[0];
    const current=JSON.parse(receipt.metadata);current.completion=metadata.completion;
    await pool.query('update billing_transactions set metadata=$1 where id=$2',[JSON.stringify(current),row.id]);
    psp.verifyTransaction=jest.fn(async(reference:string)=>{
      const payment=(await pool.query('select * from billing_transactions where reference=$1',[reference])).rows[0];
      return {reference,status:'success',currency:'NGN',domain:'test',amount:payment.amount_ngn_kobo,customer:{email:'owner@example.test'},metadata:{userId:owner,transactionId:payment.id}};
    });
    psp.chargeAuthorization=jest.fn(async()=>({status:'pending'}));
    return {svc,sub,consent};
  }
  test('recurring charge races dispatch once and grant one new paid generation',async()=>{
    const psp:any=provider();const {svc,sub}=await renewableSubscription(psp);
    await Promise.all(Array.from({length:5},()=>svc.renew(sub.id)));
    expect(psp.chargeAuthorization).toHaveBeenCalledTimes(1);
    expect((await pool.query("select count(*)::int count from billing_transactions where type='subscription_renewal'")).rows[0].count).toBe(1);
    expect((await svc.entitlement(owner,'chat')).entitled).toBe(true);
    expect(await svc.renew(sub.id)).toEqual({status:'not_due'});
  });
  test('concurrent renewal worker replicas use one durable provider charge and recover the entitlement', async () => {
    const psp: any = provider(); const { svc } = await renewableSubscription(psp);
    const workers = Array.from({ length: 3 }, () => new SubscriptionRenewalWorker(db, svc));
    await Promise.all(workers.map(worker => worker.run()));
    await Promise.all(workers.map(worker => worker.run()));
    expect(psp.chargeAuthorization).toHaveBeenCalledTimes(1);
    expect((await svc.entitlement(owner, 'chat')).entitled).toBe(true);
    expect((await pool.query("select count(*)::int count from billing_transactions where type='subscription_renewal'")).rows[0].count).toBe(1);
    workers.forEach(worker => worker.onModuleDestroy());
  });
  test('renewal worker scans at most 50 pending records per cycle and advances its cursor', async () => {
    await db.insert(schema.billingTransactions).values(Array.from({ length: 101 }, () => ({ userId: owner, type: 'subscription_renewal' as const,
      provider: 'paystack' as const, status: 'pending' as const, reference: 'bounded-' + randomUUID(), amountUsdCents: 500 })));
    const payments: any = { recoverReference: jest.fn(async () => ({})), renew: jest.fn() };
    const worker = new SubscriptionRenewalWorker(db, payments);
    await worker.run(); expect(payments.recoverReference).toHaveBeenCalledTimes(50);
    await worker.run(); expect(payments.recoverReference).toHaveBeenCalledTimes(100);
    await worker.run(); expect(payments.recoverReference).toHaveBeenCalledTimes(101);
    expect(new Set(payments.recoverReference.mock.calls.map((call: any[]) => call[1])).size).toBe(101);
    expect(payments.renew).not.toHaveBeenCalled(); worker.onModuleDestroy();
  });
  test('renewal respects owner FX ceiling and cancellation before dispatch',async()=>{
    const psp:any=provider();const {svc,sub}=await renewableSubscription(psp,100);
    await expect(svc.renew(sub.id)).rejects.toThrow('agreed charge limit');
    expect(psp.chargeAuthorization).not.toHaveBeenCalled();
    await svc.cancel(owner,sub.id);expect(await svc.renew(sub.id)).toEqual({status:'not_due'});
    expect((await svc.entitlement(owner,'chat')).entitled).toBe(false);
  });
  test('lost renewal response is recovered without charging again, including cancellation after dispatch',async()=>{
    const psp:any=provider();const {svc,sub}=await renewableSubscription(psp);
    psp.chargeAuthorization.mockRejectedValue(Error('ack lost'));
    await expect(svc.renew(sub.id)).rejects.toThrow('unconfirmed');
    const row=(await pool.query("select * from billing_transactions where type='subscription_renewal'")).rows[0];
    await svc.cancel(owner,sub.id);
    await svc.recoverReference(owner,row.reference);
    await svc.recoverReference(owner,row.reference);
    expect(psp.chargeAuthorization).toHaveBeenCalledTimes(1);
    expect((await pool.query('select cancel_at_period_end from billing_subscriptions')).rows[0].cancel_at_period_end).toBe(true);
    expect((await svc.entitlement(owner,'chat')).entitled).toBe(true);
    await expect(svc.recoverReference(randomUUID(),row.reference)).rejects.toThrow('not found');
  });
  async function settlementFixture(price = 100_000_000n, model = 'cpc', reserve = true) {
    const submissionId = randomUUID();
    const [campaign] = await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Versioned settlement fixture',budgetUsdCents:1000,
      remainingBudgetUsdCents:1000,status:'paused',moderationStatus:'approved',pricingVersion:2,pricingModel:model,
      contentRevision:1,approvedRevision:1,currentSubmissionId:submissionId,approvedSubmissionId:submissionId}).returning();
    await db.insert(schema.billingWallets).values({userId:owner,balanceUsdCents:2000});
    if (reserve) await new CampaignEscrowService(db).change(owner,campaign.id,'reserve',undefined,'active');
    const publisher=randomUUID();await pool.query("insert into users(id,email,status) values($1,'publisher@example.test','ACTIVE')",[publisher]);
    const [promoter]=await db.insert(schema.adsPromoters).values({userId:publisher,type:'INDIVIDUAL'}).returning();
    const [stack]=await db.insert(schema.adsCreativeStacks).values({campaignId:campaign.id,name:'Ad Stack #1',position:1}).returning();
    const [creative]=await db.insert(schema.adsCreatives).values({campaignId:campaign.id,adStackId:stack.id,headline:'Reviewed',destinationUrl:'https://example.test',status:'active',reviewStatus:'approved'}).returning();
    const [placement]=await db.insert(schema.adsPlacements).values({campaignId:campaign.id,creativeId:creative.id,promoterId:promoter.id,placementToken:randomUUID()}).returning();
    const add=async(version=2)=>{
      const [serve]=await db.insert(schema.adsServes).values({campaignId:campaign.id,creativeId:creative.id,promoterId:promoter.id,
        placementId:placement.id,slotHandle:'fixture',pricingModel:model,pricingVersion:2,billingPriceNanos:price}).returning();
      const [event]=await db.insert(schema.adsInteractions).values({placementId:placement.id,promoterId:promoter.id,serveId:serve.id,
        type:model==='cpm'?'viewable_impression':'click',verificationVersion:version,isValid:true}).returning();
      await pool.query('select pg_sleep(0.01)'); // Closed test period, avoiding JS millisecond/PG microsecond boundary ambiguity.
      return {serve,event};
    };
    return {campaign,publisher,promoter,creative,placement,add,svc:new AdSettlementService(db)};
  }
  test('PLAN0103 network and legacy attribution survives real HTTP without cross-owner or invalid metrics', async () => {
    const f = await settlementFixture(100_000_000n, 'cpc', false);
    const foreign = randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'foreign@example.test','ACTIVE')", [foreign]);
    const [other] = await db.insert(schema.adsCampaigns).values({advertiserId:foreign,title:'Other',budgetUsdCents:1000,remainingBudgetUsdCents:1000}).returning();
    const makeServe = async (values: any = {}) => (await db.insert(schema.adsServes).values({campaignId:f.campaign.id,creativeId:f.creative.id,promoterId:f.promoter.id,slotHandle:'network',...values}).returning())[0];
    const event = async (serve: any, values: any = {}) => db.insert(schema.adsInteractions).values({promoterId:f.promoter.id,serveId:serve.id,type:'impression',source:'embed',isValid:true,...values});
    // Rejected attribution paths first: no fallback from an unknown or non-paid serve.
    await event({id:randomUUID()}, {placementId:f.placement.id});
    await event(await makeServe({inventoryClass:'house'}), {placementId:f.placement.id});
    await event(await makeServe({inventoryClass:'shadow',deliveryMode:'shadow'}));
    await event(await makeServe({campaignId:other.id}), {placementId:f.placement.id});
    await event(await makeServe(), {isValid:false});
    await event(await makeServe(), {createdAt:new Date(Date.now()-100*86400000)});
    await event(await makeServe(), {createdAt:new Date(Date.now()+86400000)});
    // Valid network events plus legacy placement-only events, without counting render/viewability twice.
    const network = await makeServe();
    for (const type of ['impression','click','hover','touch','render','viewable_impression']) await event(network,{type});
    await db.insert(schema.adsInteractions).values({placementId:f.placement.id,promoterId:f.promoter.id,type:'impression',source:'embed',isValid:true});
    await event(await makeServe({campaignId:other.id}));
    @Module({controllers:[AnalyticsController,CampaignsController],providers:[
      {provide:AnalyticsService,useValue:new AnalyticsService(db)}, {provide:PromotersService,useValue:{}},
      {provide:CampaignsService,useValue:new CampaignsService(db,{} as any,{} as any)},
    ]}) class MetricsFixture {}
    const jwt = new JwtService({secret:'plan0103-isolated-signing-key'});
    const app = await NestFactory.create(MetricsFixture,{logger:false});
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,{rolesFor:()=>[]} as any));
    await app.listen(0,'127.0.0.1');
    const get = async (route:string,actor=owner,auth=true) => {
      const token=jwt.sign({sub:actor,email:'fixture@example.test',type:'access'},{expiresIn:'2m'});
      const response=await fetch((await app.getUrl())+'/api/v1/'+route,{headers:auth?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(5000)});
      return {status:response.status,body:await response.json() as any};
    };
    try {
      expect((await get('analytics/dashboard/summary',owner,false)).status).toBe(401);
      const summary=await get('analytics/dashboard/summary?period=30d');
      expect(summary.status).toBe(200);
      expect(summary.body.data.performance).toMatchObject({impressions:2,clicks:1,hovers:1,touches:1});
      const timeseries=(await get('analytics/dashboard/timeseries?period=30d')).body.data;
      expect(timeseries.reduce((sum:number,r:any)=>sum+r.impressions,0)).toBe(2);
      expect(timeseries.reduce((sum:number,r:any)=>sum+r.spendUsd,0)).toBe(0);
      const channels=(await get('analytics/dashboard/channel-breakdown?period=30d')).body.data;
      expect(channels[0]).toMatchObject({impressions:2,clicks:1,percentage:100});
      expect(channels[1].percentage).toBe(0);
      const campaigns=(await get('campaigns/page')).body.data.items;
      // Lifetime campaign list includes the old and future records; dashboard is period-bound.
      expect(campaigns[0]).toMatchObject({id:f.campaign.id,impressionsCount:4,clicksCount:1,hoversCount:1,touchesCount:1});
      const ts = require('typescript');
      const exports: any = {};
      const consumerSource = readFileSync(resolve(__dirname,'../../../../frontend/web/ads/src/lib/campaigns-api.ts'),'utf8');
      require('vm').runInNewContext(ts.transpileModule(consumerSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:()=>({})});
      expect(exports.campaignView(campaigns[0])).toMatchObject({metricsLoaded:true,impressions:4,clicks:1,hovers:1,touches:1});
      const outsider=(await get('analytics/dashboard/summary',foreign)).body.data;
      expect(outsider.performance.impressions).toBe(1);
      expect((await get('campaigns/page',foreign)).body.data.items[0]).toMatchObject({id:other.id,impressionsCount:1});
      // A real completed internal debit determines spend; failed/foreign receipts do not.
      await db.insert(schema.billingTransactions).values([
        {userId:owner,type:'ads_spend',provider:'internal',status:'completed',reference:randomUUID(),amountUsdCents:10,metadata:JSON.stringify({campaignId:f.campaign.id}),createdAt:new Date(Date.now()-1000)},
        {userId:owner,type:'ads_spend',provider:'internal',status:'failed',reference:randomUUID(),amountUsdCents:99,metadata:JSON.stringify({campaignId:f.campaign.id})},
        {userId:foreign,type:'ads_spend',provider:'internal',status:'completed',reference:randomUUID(),amountUsdCents:99,metadata:JSON.stringify({campaignId:other.id})},
      ]);
      const billed=(await get('analytics/dashboard/timeseries')).body.data;
      expect(billed.reduce((sum:number,r:any)=>sum+r.spendUsd,0)).toBe(0.1);
      expect((await pool.query('select count(*)::int n from ads_settlement_claims')).rows[0].n).toBe(0);
    } finally {await app.close();}
  },30000);

  test('PLAN0104 signed redirects record valid, duplicate and changed-IP outcomes and reconcile audit HTTP', async () => {
    const prior={...process.env};
    Object.assign(process.env,{ADS_IMPRESSION_SIGNING_KEY:'plan0103-local-signing-secret-32-bytes',ADS_EVIDENCE_HASH_SECRET:'plan0103-local-evidence-secret-32-bytes'});
    try {
      const f=await settlementFixture(100_000_000n,'cpc',false);
      const tokens=new ImpressionTokenService(); const fraud=new FraudRulesService();
      const validate=jest.spyOn(fraud,'validateClick');
      const servedAt=new Date(Date.now()-1000);
      const [serve]=await db.insert(schema.adsServes).values({campaignId:f.campaign.id,creativeId:f.creative.id,promoterId:f.promoter.id,
        placementId:null,slotId:randomUUID(),slotHandle:'network',ipHash:'unknown',servedAt,contentSnapshot:{destinationUrl:'https://example.test'}}).returning();
      // Signed network tokens use the sentinel only in transport; storage retains null placement.
      const token=tokens.generateToken({servedId:serve.id,placementId:HOUSE_PLACEMENT_UUID,campaignId:f.campaign.id,creativeId:f.creative.id,promoterId:f.promoter.id,ipHash:'unknown'});
      const delivery=new DeliveryService(db,tokens,new AuctionEngineService(),fraud,undefined,new EvidenceService(db, {} as any));
      await expect(delivery.handleClick('imp_invalid.a',undefined,'Mozilla/5.0 Chrome/130')).rejects.toThrow('invalid or expired');
      expect(validate).not.toHaveBeenCalled();
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(await delivery.handleClick(token,undefined,'Mozilla/5.0 Chrome/130')).toMatch(/^https:\/\/example.test\?cf_click=/);
      expect(validate).toHaveBeenCalledTimes(1);
      const restarted = new DeliveryService(db,tokens,new AuctionEngineService(),new FraudRulesService(),undefined,new EvidenceService(db, {} as any));
      await restarted.handleClick(token,undefined,'Mozilla/5.0 Chrome/131');
      expect(validate).toHaveBeenCalledTimes(1);
      await expect(delivery.handleClick(token,'192.0.2.11','Mozilla/5.0 Chrome/130')).resolves.toContain('cf_click=');
      expect(validate).toHaveBeenCalledTimes(1);
      const pending=(await pool.query("select interaction_id, recording_reason from ads_clicks where recording_reason is not null")).rows;
      expect(pending).toEqual([{interaction_id:null,recording_reason:'IP_BINDING_MISMATCH'}]);
      // Reproduce the durable state when ingestion commits and the link write is lost.
      const linkage = await pool.query("update ads_clicks r set interaction_id=null, recording_reason='RECORDING_UNCONFIRMED' from ads_interactions i where r.interaction_id=i.id and i.event_id=r.id and i.is_valid returning r.id");
      expect(linkage.rowCount).toBe(1);
      // A historical unlinked receipt has no persisted reason.
      await db.insert(schema.adsClicks).values({clickId:'clk_fixture_historical',serveId:serve.id,
        campaignId:f.campaign.id,promoterId:f.promoter.id,expiresAt:new Date(Date.now()+3600000)});
      const [staff]=await pool.query("insert into users(id,email,status) values($1,'click-audit@example.test','ACTIVE') returning id",[randomUUID()]).then(r=>r.rows);
      const campaigns=new CampaignsService(db,{} as any,{} as any);
      @Module({controllers:[ClickAuditController],providers:[{provide:DATABASE_TOKEN,useValue:db}]})
      class ClickAuditFixture {}
      const app=await NestFactory.create(ClickAuditFixture,{logger:false});
      const jwt=new JwtService({secret:'plan0104-isolated-report-key'});
      app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,{rolesFor:(actor:string)=>actor===staff.id?['ads_admin']:[]} as any));
      await app.listen(0,'127.0.0.1');
      const get=async(query:string,actor?:string)=>{
        const access=actor&&jwt.sign({sub:actor,email:'fixture@example.test',type:'access'},{expiresIn:'1m'});
        const response=await fetch((await app.getUrl())+'/admin/ads/click-audit?'+query,{
          headers:access?{Authorization:'Bearer '+access}:{},signal:AbortSignal.timeout(5000),
        });
        return {status:response.status,body:await response.json() as any};
      };
      try {
        const filter='campaign='+f.campaign.id;
        expect((await get(filter)).status).toBe(401);
        expect((await get(filter,owner)).status).toBe(403);
        expect((await get('campaign=invalid',staff.id)).status).toBe(400);
        const audit=await get(filter,staff.id);
        expect(audit.status).toBe(200);
        expect(audit.body.data.counts).toEqual({all:4,redirects:4,valid:1,rejected:1,missing:2,billed:0});
        expect((await get(filter+'&outcome=missing',staff.id)).body.data.items).toEqual(expect.arrayContaining([
          expect.objectContaining({event_id:null,valid:null,reason:'IP_BINDING_MISMATCH'}),
          expect.objectContaining({event_id:null,valid:null,reason:null}),
        ]));
        expect((await get('campaign='+randomUUID(),staff.id)).body.data.total).toBe(0);
        const campaignPage=await campaigns.campaignPage(owner,'all',1,10,'','clicks_desc');
        expect(campaignPage.items[0]).toMatchObject({clicksCount:4,validClicksCount:1,billedClicksCount:0});
      } finally { await app.close(); }
      const rows=(await pool.query("select is_valid,invalid_reason,verification_version from ads_interactions where type='click' order by created_at")).rows;
      expect(rows).toEqual([{is_valid:true,invalid_reason:null,verification_version:2},{is_valid:false,invalid_reason:'DUP_CLICK',verification_version:0}]);
      expect((await pool.query('select count(*)::int n from ads_evidence_records')).rows[0].n).toBe(2);
      expect((await pool.query('select count(*)::int n from ads_settlement_claims')).rows[0].n).toBe(0);
    } finally {process.env=prior;}
  },30000);

  test.each(['cpm', 'cpc'] as const)('PLAN0102 daily reports reconcile %s expense, receipts and ownership over HTTP', async model => {
    const cpm = model === 'cpm';
    const price = cpm ? 6_000_000n : 100_000_000n;
    const f = await settlementFixture(price, model);
    @Module({controllers:[ReportsController],providers:[{provide:ReportsService,useValue:new ReportsService(db)}]})
    class ReportsFixture {}
    const jwt = new JwtService({secret:'plan0102-report-isolation-key'});
    const app = await NestFactory.create(ReportsFixture,{logger:false});
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,{rolesFor:()=>[]} as any));
    await app.listen(0,'127.0.0.1');
    const get = async (query:string, actor?:string) => {
      const token=actor && jwt.sign({sub:actor,email:'fixture@example.test',type:'access'},{expiresIn:'2m'});
      const response=await fetch((await app.getUrl())+'/api/v1/reports/daily?'+query,{
        headers:token?{Authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(5000),
      });
      return {status:response.status,body:await response.json() as any};
    };
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const range = 'from='+today+'&to='+today+'&compare=true';
    try {
      expect((await get(range)).status).toBe(401);
      expect((await get('from=2026-02-30',owner)).status).toBe(400);
      expect((await get('role=admin',owner)).status).toBe(400);
      expect((await get('compare=yes',owner)).status).toBe(400);
      await f.add();
      await f.svc.settle(f.campaign.id,randomUUID(),new Date());
      const fractional=(await get(range,owner)).body.data;
      expect(fractional.totals).toMatchObject({spend:price.toString(),posted:cpm?'0':'100000000',
        billableImpressions:cpm?'1':'0',billableClicks:cpm?'0':'1'});
      await f.add();
      await f.svc.settle(f.campaign.id,randomUUID(),new Date());
      if (!cpm) {
        const [item] = await db.select().from(schema.adsPromoterSettlementItems).limit(1);
        // Fixture states reflect a cleared receipt, an audited advertiser rebate,
        // and a recovery posted against the promoter's cleared earnings.
        await pool.query("update billing_transactions set status='completed' where id=$1",[item.billingTransactionId]);
        await db.insert(schema.billingTransactions).values([
          {userId:owner,type:'internal_credit',provider:'internal',status:'completed',reference:randomUUID(),
            idempotencyKey:'ads-rejection:v1:'+randomUUID(),amountUsdCents:3,createdAt:new Date(Date.now()-1000),metadata:JSON.stringify({campaignId:f.campaign.id})},
          {userId:f.publisher,type:'internal_debit',provider:'internal',status:'completed',reference:randomUUID(),
            idempotencyKey:'ads-recovery:v1:'+randomUUID(),amountUsdCents:1,createdAt:new Date(Date.now()-1000),metadata:JSON.stringify({itemId:item.id})},
        ]);
      }
      const advertiser=await get(range,owner);
      expect(advertiser.status).toBe(200);
      const spend = (price * 2n).toString();
      expect(advertiser.body.data.totals).toMatchObject({spend,posted:cpm?'10000000':'200000000',credits:cpm?'0':'30000000',
        billableImpressions:cpm?'2':'0',billableClicks:cpm?'0':'2'});
      expect(advertiser.body.data.daily[0]).toMatchObject({date:today,incomplete:true,spend});
      expect(advertiser.body.data.comparison.totals.spend).toBe('0');
      expect(advertiser.body.data.breakdown.some((row:any)=>row.creativeId===f.creative.id && row.spend===spend)).toBe(true);
      expect((await get(range,f.publisher)).body.data.totals.spend).toBe('0');
      const earnings=(await get(range+'&role=promoter',f.publisher)).body.data;
      expect(earnings.totals).toMatchObject({billableImpressions:cpm?'2':'0',billableClicks:cpm?'0':'2',spend:'0',
        adjustments:cpm?'0':'-10000000'});
      if (!cpm) {
        expect(BigInt(earnings.totals.confirmed)).toBeGreaterThan(0n);
        expect(BigInt(earnings.totals.pending) + BigInt(earnings.totals.confirmed)).toBe(110000000n);
      }
      const unrelated = (await get(range+'&role=promoter',owner)).body.data.totals;
      expect(unrelated).toMatchObject({billableImpressions:'0',billableClicks:'0',pending:'0',confirmed:'0'});
      const ts = require('typescript');
      const consumer: any = {};
      const source = readFileSync(resolve(__dirname,'../../../../frontend/web/ads/src/lib/daily-reports.ts'),'utf8');
      require('vm').runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
        exports:consumer, URLSearchParams, require:()=>({apiData:async()=>advertiser.body.data}),
      });
      expect((await consumer.readDailyReport('advertiser',range,new AbortController().signal)).totals.spend).toBe(spend);
    } finally {await app.close();}
  },30000);

  test('PLAN0101 advertiser campaign metrics are owner-scoped and returned over HTTP', async () => {
    const own = await settlementFixture(100_000_000n, 'cpc', false);
    await db.insert(schema.adsInteractions).values([
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'impression', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'impression', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'viewable_impression', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'click', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'click', isValid: false },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'hover', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'touch', isValid: true },
      { placementId: own.placement.id, promoterId: own.promoter.id, type: 'render', isValid: true },
    ]);

    const foreignAdvertiser = randomUUID();
    const foreignPublisher = randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'foreign-advertiser@example.test','ACTIVE'),($2,'foreign-publisher@example.test','ACTIVE')", [foreignAdvertiser, foreignPublisher]);
    const [foreignCampaign] = await db.insert(schema.adsCampaigns).values({
      advertiserId: foreignAdvertiser,
      title: 'Foreign campaign',
      budgetUsdCents: 1000,
      remainingBudgetUsdCents: 1000,
      status: 'paused',
      moderationStatus: 'approved',
      pricingVersion: 2,
      pricingModel: 'cpc',
      contentRevision: 1,
      approvedRevision: 1,
    }).returning();
    const [foreignPromoter] = await db.insert(schema.adsPromoters).values({ userId: foreignPublisher, type: 'INDIVIDUAL' }).returning();
    const [foreignStack] = await db.insert(schema.adsCreativeStacks).values({ campaignId: foreignCampaign.id, name: 'Foreign stack', position: 1 }).returning();
    const [foreignCreative] = await db.insert(schema.adsCreatives).values({
      campaignId: foreignCampaign.id,
      adStackId: foreignStack.id,
      headline: 'Foreign creative',
      destinationUrl: 'https://example.test/foreign',
      status: 'active',
      reviewStatus: 'approved',
    }).returning();
    const [foreignPlacement] = await db.insert(schema.adsPlacements).values({
      campaignId: foreignCampaign.id,
      creativeId: foreignCreative.id,
      promoterId: foreignPromoter.id,
      placementToken: randomUUID(),
    }).returning();
    await db.insert(schema.adsInteractions).values({
      placementId: foreignPlacement.id,
      promoterId: foreignPromoter.id,
      type: 'impression',
      isValid: true,
    });

    @Module({
      controllers: [CampaignsController],
      providers: [{ provide: CampaignsService, useValue: new CampaignsService(db, {} as any, {} as any) }],
    })
    class CampaignMetricsFixture {}
    const jwt = new JwtService({ secret: 'plan0101-isolated-test-signing-key' });
    const app = await NestFactory.create(CampaignMetricsFixture, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalGuards(new AdsAccessGuard(jwt, new Reflector(), db, { rolesFor: () => [] } as any));
    await app.listen(0, '127.0.0.1');

    async function campaignPage(actor: string, query = '') {
      const token = jwt.sign({ sub: actor, email: 'fixture@example.test', type: 'access' }, { expiresIn: '2m' });
      const response = await fetch((await app.getUrl()) + '/api/v1/campaigns/page' + query, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() as any };
    }

    try {
      expect((await campaignPage(owner, '?page=0')).status).toBe(400);

      const ownPage = await campaignPage(owner);
      expect(ownPage.status).toBe(200);
      expect(ownPage.body.data.items).toHaveLength(1);
      expect(ownPage.body.data.items[0]).toMatchObject({
        id: own.campaign.id,
        impressionsCount: 2,
        clicksCount: 2,
        validClicksCount: 1,
        billedClicksCount: 0,
        hoversCount: 1,
        touchesCount: 1,
      });

      const foreignPage = await campaignPage(foreignAdvertiser);
      expect(foreignPage.status).toBe(200);
      expect(foreignPage.body.data.items).toHaveLength(1);
      expect(foreignPage.body.data.items[0]).toMatchObject({
        id: foreignCampaign.id,
        impressionsCount: 1,
        clicksCount: 0,
        hoversCount: 0,
        touchesCount: 0,
      });
    } finally {
      await app.close();
    }
  }, 30000);
  test('PLAN0081 readiness HTTP scopes accounts and distinguishes House, paid serve and render', async () => {
    const f = await settlementFixture(undefined, undefined, false);
    await pool.query("update ads_campaigns set status='active' where id=$1", [f.campaign.id]);
    const staff = randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'readiness-staff@example.test','ACTIVE')", [staff]);
    const { serve, event } = await f.add();
    await pool.query("update ads_serves set inventory_class='house' where id=$1", [serve.id]);
    @Module({ controllers: [CampaignsController, AdminPerformanceController], providers: [{ provide: DATABASE_TOKEN, useValue: db }, {
      provide: CampaignsService, useValue: new CampaignsService(db, {} as any, {} as any),
    }] })
    class ReadinessFixture {}
    const jwt = new JwtService({ secret: 'local-readiness-test-key' });
    const grants = { rolesFor: (id: string) => id === staff ? ['ads_admin'] : [] } as unknown as AdsStaffGrants;
    const app = await NestFactory.create(ReadinessFixture, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalGuards(new AdsAccessGuard(jwt, new Reflector(), db, grants));
    await app.listen(0, '127.0.0.1');
    async function request(actor: string, admin = false, path?: string) {
      const prefix = admin ? 'admin/' : '';
      const token = jwt.sign({ sub: actor, email: 'fixture@example.test', type: 'access' }, { expiresIn: '2m' });
      const response = await fetch((await app.getUrl()) + (path ?? '/api/v1/campaigns/' + prefix + f.campaign.id + '/delivery-readiness'), {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() as any };
    }
    try {
      expect((await request(f.publisher)).status).toBe(404);
      expect((await request(owner, true)).status).toBe(403);
      const own = await request(owner);
      const admin = await request(staff, true);
      expect(own.status).toBe(200);
      expect(admin.status).toBe(200);
      const gate = (result: typeof own, code: string) => result.body.data.gates.find((g: any) => g.gateCode === code);
      expect(gate(own, 'ADVERTISER_EMAIL').status).toBe('action_required');
      expect(gate(own, 'ADVERTISER_EMAIL').action).toBe('verify_email');
      expect(gate(admin, 'ADVERTISER_EMAIL').action).toBeUndefined();
      expect(gate(own, 'PAID_SERVE').status).toBe('unknown');
      expect(gate(admin, 'PAID_SERVE').status).toBe('unknown');
      await pool.query("update ads_serves set inventory_class='paid' where id=$1", [serve.id]);
      const issued = await request(owner);
      expect(gate(issued, 'PAID_SERVE').status).toBe('observed');
      expect(gate(issued, 'PAID_RENDER').status).toBe('unknown');
      expect(gate(issued, 'BILLABLE_EVENT').status).toBe('unknown');
      expect(gate(issued, 'RECONCILIATION').status).toBe('unknown');
      await db.insert(schema.adsInteractions).values({ placementId: f.placement.id, promoterId: f.promoter.id,
        serveId: serve.id, type: 'render', isValid: true });
      const rendered = await request(owner);
      expect(gate(rendered, 'PAID_RENDER').status).toBe('observed');
      expect(gate(rendered, 'BILLABLE_EVENT').status).toBe('unknown');
      expect(rendered.body.data).not.toHaveProperty('publisherId');
      const [reservation] = await db.insert(schema.adsOpportunityReservations).values({
        campaignId: f.campaign.id, serveId: serve.id, opportunityId: randomUUID(),
        state: 'CLAIMED', claimedAt: new Date(), claimEventId: event.id, expiresAt: new Date(Date.now() + 60000),
      }).returning();
      await pool.query('update ads_serves set opportunity_reservation_id=$1 where id=$2', [reservation.id, serve.id]);
      expect(gate(await request(owner), 'BILLABLE_EVENT').status).toBe('pending');
      await db.insert(schema.adsEventAssessments).values({ eventId: event.id, campaignId: f.campaign.id,
        requestId: randomUUID(), actorId: staff, policyVersion: 'local-fixture', outcome: 'eligible',
        reasonCodes: [], features: {}, recordHash: 'fixture', keyId: 'fixture' });
      const assessed = await request(owner);
      expect(gate(assessed, 'BILLABLE_EVENT').status).toBe('observed');
      expect(gate(assessed, 'RECONCILIATION').status).toBe('unknown');

      const operations = '/api/v1/admin/ads/readiness/operations';
      expect((await request(owner, false, operations)).status).toBe(403);
      const sample = await request(staff, false, operations);
      expect(sample.status).toBe(200);
      expect(sample.body.data).toMatchObject({ campaigns: 1, unverifiedAdvertisers: 1, managerReviewCampaigns: 0 });
    } finally { await app.close(); }
  });

  test('independent rejection invalidates the fractional claim chain and rebates only its funded cents once', async () => {
    const f = await settlementFixture(6_000_000n, 'cpm');
    for (let n = 0; n < 3; n++) { await f.add(); await f.svc.settle(f.campaign.id, randomUUID(), new Date()); }
    const escrow = (await pool.query('select * from ads_campaign_escrows')).rows[0];
    const preparer = randomUUID(), reviewer = randomUUID();
    for (const actor of [preparer, reviewer]) await pool.query("insert into users(id,email,status) values($1,'operator@example.test','ACTIVE')", [actor]);
    const authority = new AdClearanceService(db, { get: () => JSON.stringify([preparer, reviewer, owner]) } as any);
    const svc = new AdRejectionService(db, authority);
    await expect(svc.prepare(owner, escrow.id, f.promoter.id, 'report')).rejects.toThrow('beneficiaries');
    const draft = await svc.prepare(preparer, escrow.id, f.promoter.id, 'fraud-claim-chain');
    expect(draft.rebateUsdCents).toBe(1); expect(draft.claims).toBe(3);
    await expect(svc.prepare(reviewer, escrow.id, f.promoter.id, 'replacement')).rejects.toThrow('immutable');
    await expect(svc.approve(preparer, escrow.id, f.promoter.id, draft.draftId)).rejects.toThrow('Independent');
    await f.add();
    await f.svc.settle(f.campaign.id, randomUUID(), new Date());
    expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(3);
    const item = (await pool.query('select * from ads_promoter_settlement_items')).rows[0];
    await pool.query("update ads_promoter_settlement_items set hold_expires_at=now()-interval '1 second'");
    const clearance = await authority.prepare(preparer, item.id, 'cannot-release-quarantined-chain');
    await expect(authority.approve(reviewer, item.id, clearance.draftId)).rejects.toThrow('rejection review');
    await Promise.all(Array.from({ length: 4 }, () => svc.approve(reviewer, escrow.id, f.promoter.id, draft.draftId)));
    expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0].balance_usd_cents).toBe(1001);
    expect((await pool.query('select count(*)::int count from ads_settlement_rebates')).rows[0].count).toBe(1);
    expect((await pool.query('select is_valid from ads_interactions where id in (select interaction_id from ads_settlement_claims)')).rows.every((row: any) => row.is_valid === false)).toBe(true);
    expect((await pool.query('select carry_nanos from ads_settlement_carries')).rows[0].carry_nanos).toBe('8000000');
    expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('1');
    expect((await pool.query('select clearance_status from ads_promoter_settlement_items')).rows[0].clearance_status).toBe('penalized');
  });
  test('rejection receipt failure rolls rebate, claim invalidation and item changes back together', async () => {
    const f = await settlementFixture(); await f.add(); await f.svc.settle(f.campaign.id, randomUUID(), new Date());
    const escrow = (await pool.query('select * from ads_campaign_escrows')).rows[0];
    const actors = [randomUUID(), randomUUID()];
    for (const actor of actors) await pool.query("insert into users(id,email,status) values($1,'operator@example.test','ACTIVE')", [actor]);
    const svc = new AdRejectionService(db, new AdClearanceService(db, { get: () => JSON.stringify(actors) } as any));
    const draft = await svc.prepare(actors[0], escrow.id, f.promoter.id, 'fraud-proof');
    await pool.query("create function reject_rebate() returns trigger language plpgsql as $$ begin raise exception 'injected rebate failure'; end $$");
    await pool.query('create trigger reject_rebate before insert on ads_settlement_rebates for each row execute function reject_rebate()');
    try {
      await expect(svc.approve(actors[1], escrow.id, f.promoter.id, draft.draftId)).rejects.toThrow();
      expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0].balance_usd_cents).toBe(1000);
      expect((await pool.query('select is_valid from ads_interactions')).rows[0].is_valid).toBe(true);
      expect((await pool.query('select clearance_status from ads_promoter_settlement_items')).rows[0].clearance_status).toBe('pending');
      expect((await pool.query('select processed from billing_provider_events where id=$1', [draft.draftId])).rows[0].processed).toBe(false);
    } finally {
      await pool.query('drop trigger reject_rebate on ads_settlement_rebates'); await pool.query('drop function reject_rebate()');
    }
    await svc.approve(actors[1], escrow.id, f.promoter.id, draft.draftId);
    expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [owner])).rows[0].balance_usd_cents).toBe(1010);
  });
  test('released earnings become debt and recover only from future clearance, with rollback and duplicate protection', async () => {
    const f = await settlementFixture(); await f.add(); await f.svc.settle(f.campaign.id, randomUUID(), new Date());
    const escrow = (await pool.query('select * from ads_campaign_escrows')).rows[0];
    const actors = [randomUUID(), randomUUID()];
    for (const actor of actors) await pool.query("insert into users(id,email,status) values($1,'operator@example.test','ACTIVE')", [actor]);
    const authority = new AdClearanceService(db, { get: () => JSON.stringify(actors) } as any);
    async function clear(itemId: string) {
      await pool.query("update ads_promoter_settlement_items set hold_expires_at=now()-interval '1 second' where id=$1", [itemId]);
      const draft = await authority.prepare(actors[0], itemId, 'independent-clearance');
      return { draft, approve: () => authority.approve(actors[1], itemId, draft.draftId) };
    }
    const oldItem = (await pool.query('select * from ads_promoter_settlement_items')).rows[0];
    await (await clear(oldItem.id)).approve();
    const svc = new AdRejectionService(db, authority);
    const rejection = await svc.prepare(actors[0], escrow.id, f.promoter.id, 'retrospective-fraud');
    expect(rejection.recoverableUsdCents).toBe(5);
    await svc.approve(actors[1], escrow.id, f.promoter.id, rejection.draftId);
    expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [f.publisher])).rows[0].balance_usd_cents).toBe(5);
    expect((await pool.query('select status from billing_transactions where id=$1', [oldItem.billing_transaction_id])).rows[0].status).toBe('completed');
    const [campaign] = await db.insert(schema.adsCampaigns).values({ advertiserId: owner, title: 'New funded generation', budgetUsdCents: 500,
      remainingBudgetUsdCents: 500, status: 'paused', moderationStatus: 'approved', pricingVersion: 2, pricingModel: 'cpc' }).returning();
    await new CampaignEscrowService(db).change(owner, campaign.id, 'reserve', undefined, 'active');
    const [stack] = await db.insert(schema.adsCreativeStacks).values({ campaignId: campaign.id, name: 'Ad Stack #1', position: 1 }).returning();
    const [creative] = await db.insert(schema.adsCreatives).values({ campaignId: campaign.id, adStackId: stack.id, headline: 'Reviewed', destinationUrl: 'https://example.test', status: 'active', reviewStatus: 'approved' }).returning();
    const [placement] = await db.insert(schema.adsPlacements).values({ campaignId: campaign.id, creativeId: creative.id, promoterId: f.promoter.id, placementToken: randomUUID() }).returning();
    for (const [index, price] of [40_000_000n, 60_000_000n].entries()) {
      const [serve] = await db.insert(schema.adsServes).values({ campaignId: campaign.id, creativeId: creative.id, promoterId: f.promoter.id,
        placementId: placement.id, slotHandle: 'fixture', pricingModel: 'cpc', pricingVersion: 2, billingPriceNanos: price }).returning();
      await db.insert(schema.adsInteractions).values({ placementId: placement.id, promoterId: f.promoter.id, serveId: serve.id, type: 'click', verificationVersion: 2, isValid: true });
      await pool.query('select pg_sleep(0.01)');
      const batch = await f.svc.settle(campaign.id, randomUUID(), new Date());
      const item = (await pool.query('select * from ads_promoter_settlement_items where batch_id=$1', [batch.batchId])).rows[0];
      const review = await clear(item.id);
      if (index === 0) {
        await pool.query("create function fail_offset() returns trigger language plpgsql as $$ begin if new.type='internal_debit' then raise exception 'injected offset failure'; end if; return new; end $$");
        await pool.query('create trigger fail_offset before insert on billing_transactions for each row execute function fail_offset()');
        try {
          await expect(review.approve()).rejects.toThrow();
          expect((await pool.query('select recovered_amount_usd_cents from ads_promoter_penalties')).rows[0].recovered_amount_usd_cents).toBe('0');
        } finally { await pool.query('drop trigger fail_offset on billing_transactions'); await pool.query('drop function fail_offset()'); }
      }
      await Promise.all(Array.from({ length: 3 }, review.approve));
      expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1', [f.publisher])).rows[0].balance_usd_cents).toBe(5);
      expect((await pool.query('select status from ads_promoter_penalties')).rows[0].status).toBe(index === 0 ? 'partially_recovered' : 'fully_recovered');
    }
    expect((await pool.query("select sum(amount_usd_cents)::int amount,count(*)::int count from billing_transactions where metadata::jsonb->>'kind'='funded_ad_recovery'")).rows[0]).toEqual({ amount: 5, count: 2 });
    expect((await pool.query('select clearance_status from ads_promoter_settlement_items where id=$1', [oldItem.id])).rows[0].clearance_status).toBe('clawed_back');
  });
  test('independent dismissal unfreezes settlement without money movement and permits a later new review', async () => {
    const f = await settlementFixture(); await f.add(); await f.svc.settle(f.campaign.id, randomUUID(), new Date());
    const escrow = (await pool.query('select * from ads_campaign_escrows')).rows[0];
    const actors = [randomUUID(), randomUUID()];
    for (const actor of actors) await pool.query("insert into users(id,email,status) values($1,'operator@example.test','ACTIVE')", [actor]);
    const svc = new AdRejectionService(db, new AdClearanceService(db, { get: () => JSON.stringify(actors) } as any));
    const draft = await svc.prepare(actors[0], escrow.id, f.promoter.id, 'suspected-fraud');
    await expect(svc.dismiss(actors[0], escrow.id, f.promoter.id, draft.draftId, 'self')).rejects.toThrow('Independent');
    await svc.dismiss(actors[1], escrow.id, f.promoter.id, draft.draftId, 'false-positive-investigation');
    await expect(svc.approve(actors[1], escrow.id, f.promoter.id, draft.draftId)).rejects.toThrow('dismissed');
    await f.add(); await f.svc.settle(f.campaign.id, randomUUID(), new Date());
    expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(2);
    const next = await svc.prepare(actors[0], escrow.id, f.promoter.id, 'new-evidence');
    expect(next.draftId).not.toBe(draft.draftId);
    expect(await svc.read(actors[1], escrow.id, f.promoter.id)).toHaveLength(2);
    expect((await pool.query('select count(*)::int count from ads_settlement_rebates')).rows[0].count).toBe(0);
  });
  test('funded settlement races claim a serve once and hold publisher earnings outside available balance',async()=>{
    const f=await settlementFixture();const {serve}=await f.add();
    await db.insert(schema.adsInteractions).values({placementId:f.placement.id,promoterId:f.promoter.id,serveId:serve.id,type:'click',verificationVersion:2,isValid:true});
    const request=randomUUID(),end=new Date(Date.now());
    await Promise.all(Array.from({length:4},()=>f.svc.settle(f.campaign.id,request,end)));
    expect((await f.svc.settle(f.campaign.id.toUpperCase(),request.toUpperCase(),end)).replayed).toBe(true);
    expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(1);
    expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('10');
    const wallet=(await pool.query('select * from billing_wallets where user_id=$1',[owner])).rows[0];expect(wallet.locked_usd_cents).toBe(990);expect(wallet.balance_usd_cents).toBe(1000);
    expect((await pool.query('select count(*)::int count from billing_wallets where user_id=$1',[f.publisher])).rows[0].count).toBe(0);
    const item=(await pool.query('select * from ads_promoter_settlement_items')).rows[0];expect(item.earned_usd_cents).toBe('5');expect(item.status).toBe('pending');expect(item.clearance_status).toBe('pending');
    expect(item.hold_expires_at.getTime()-item.created_at.getTime()).toBeGreaterThan(71*3600000);
    await f.svc.settle(f.campaign.id,randomUUID(),new Date());expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('10');
  });
  test('CPM fractions survive batch boundaries and only whole cents consume escrow',async()=>{
    const f=await settlementFixture(5_000_000n,'cpm');await f.add();
    await f.svc.settle(f.campaign.id,randomUUID(),new Date());
    expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('0');
    expect((await pool.query('select carry_nanos from ads_settlement_carries')).rows[0].carry_nanos).toBe('5000000');
    await f.add();await f.svc.settle(f.campaign.id,randomUUID(),new Date());
    expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('1');
    expect((await pool.query('select carry_nanos from ads_settlement_carries')).rows[0].carry_nanos).toBe('0');
  });
  test('unproven legacy events cannot settle and injected receipt failure rolls all claims and funds back',async()=>{
    const f=await settlementFixture();await f.add(0);await f.svc.settle(f.campaign.id,randomUUID(),new Date());
    expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(0);
    await f.add();
    await pool.query("create function reject_ad_receipt() returns trigger language plpgsql as $$ begin if new.type='ads_spend' then raise exception 'injected spend failure'; end if; return new; end $$");
    await pool.query('create trigger fail_ad_receipt before insert on billing_transactions for each row execute function reject_ad_receipt()');
    try {await expect(f.svc.settle(f.campaign.id,randomUUID(),new Date())).rejects.toThrow();
      expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(0);
      expect((await pool.query('select consumed_usd_cents from ads_campaign_escrows')).rows[0].consumed_usd_cents).toBe('0');}
    finally {await pool.query('drop trigger fail_ad_receipt on billing_transactions');await pool.query('drop function reject_ad_receipt()');}
    await f.svc.settle(f.campaign.id,randomUUID(),new Date());expect((await pool.query('select count(*)::int count from ads_settlement_claims')).rows[0].count).toBe(1);
  });
  test('72-hour clearance needs independent active operators and concurrent approvals credit once',async()=>{
    const f=await settlementFixture();await f.add();await f.svc.settle(f.campaign.id,randomUUID(),new Date());
    const item=(await pool.query('select * from ads_promoter_settlement_items')).rows[0];
    const preparer=randomUUID(),reviewer=randomUUID();
    for(const actor of [preparer,reviewer])await pool.query("insert into users(id,email,status) values($1,'operator@example.test','ACTIVE')",[actor]);
    const svc=new AdClearanceService(db,{get:()=>JSON.stringify([preparer,reviewer,owner,f.publisher])} as any);
    await expect(svc.prepare(preparer,item.id,'audit-evidence')).rejects.toThrow('72-hour');
    await pool.query("update ads_promoter_settlement_items set hold_expires_at=now()-interval '1 second' where id=$1",[item.id]);
    await expect(svc.prepare(owner,item.id,'audit-evidence')).rejects.toThrow('beneficiaries');
    const draft=await svc.prepare(preparer,item.id,'audit-evidence');
    await expect(svc.read(randomUUID(),item.id)).rejects.toThrow('operator access');
    expect((await svc.read(reviewer,item.id.toUpperCase())).review?.draftId).toBe(draft.draftId);
    await expect(svc.prepare(reviewer,item.id,'replacement')).rejects.toThrow('immutable');
    await expect(svc.approve(preparer.toUpperCase(),item.id,draft.draftId)).rejects.toThrow('Independent');
    await pool.query("update users set status='SUSPENDED' where id=$1",[preparer]);
    await expect(svc.approve(reviewer,item.id,draft.draftId)).rejects.toThrow('Active settlement');
    await pool.query("update users set status='ACTIVE' where id=$1",[preparer]);
    const approvals = await Promise.allSettled(Array.from({length:4},()=>svc.approve(reviewer,item.id,draft.draftId)));
    expect(approvals.map(result => result.status)).toEqual(Array(4).fill('fulfilled'));
    const wallet=(await pool.query('select * from billing_wallets where user_id=$1',[f.publisher])).rows[0];expect(wallet.balance_usd_cents).toBe(5);expect(wallet.version).toBe(1);
    expect((await pool.query('select clearance_status from ads_promoter_settlement_items')).rows[0].clearance_status).toBe('cleared');
    expect((await pool.query('select total_credited_usd_cents from ads_settlement_batches where id=$1',[item.batch_id])).rows[0].total_credited_usd_cents).toBe('5');
  });
  test('clearance receipt failure rolls publisher credit back and invalidated claims prevent release',async()=>{
    const f=await settlementFixture();const {event}=await f.add();await f.svc.settle(f.campaign.id,randomUUID(),new Date());
    const item=(await pool.query('select * from ads_promoter_settlement_items')).rows[0];
    const preparer=randomUUID(),reviewer=randomUUID();for(const actor of [preparer,reviewer])await pool.query("insert into users(id,email,status) values($1,'reviewer@example.test','ACTIVE')",[actor]);
    const svc=new AdClearanceService(db,{get:()=>JSON.stringify([preparer,reviewer])} as any);
    await pool.query("update ads_promoter_settlement_items set hold_expires_at=now()-interval '1 second' where id=$1",[item.id]);
    const draft=await svc.prepare(preparer,item.id,'verified-report');
    await pool.query('update ads_interactions set is_valid=false where id=$1',[event.id]);
    await expect(svc.approve(reviewer,item.id,draft.draftId)).rejects.toThrow('fraud reconciliation');
    await pool.query('update ads_interactions set is_valid=true where id=$1',[event.id]);
    await pool.query("create function reject_clearance() returns trigger language plpgsql as $$ begin if new.type='ads_earning' and new.status='completed' then raise exception 'injected clearance failure'; end if; return new; end $$");
    await pool.query('create trigger fail_clearance before update on billing_transactions for each row execute function reject_clearance()');
    try {await expect(svc.approve(reviewer,item.id,draft.draftId)).rejects.toThrow();expect((await pool.query('select count(*)::int count from billing_wallets where user_id=$1',[f.publisher])).rows[0].count).toBe(0);}
    finally {await pool.query('drop trigger fail_clearance on billing_transactions');await pool.query('drop function reject_clearance()');}
    await svc.approve(reviewer,item.id,draft.draftId);expect((await pool.query('select balance_usd_cents from billing_wallets where user_id=$1',[f.publisher])).rows[0].balance_usd_cents).toBe(5);
  });
  test('concurrent connections and service instances credit one intent exactly once', async()=>{
    const row=await intent();await Promise.all(Array.from({length:8},()=>service().completeSuccessfulFunding(row.id,proof(row))));
    const wallet=(await pool.query('select * from billing_wallets')).rows[0];expect(wallet.balance_usd_cents).toBe(500);expect(wallet.version).toBe(1);
    const receipt=(await pool.query('select * from billing_transactions')).rows[0];expect(receipt.idempotency_key).toBe('wallet-fund:v2:'+row.id);expect(receipt.balance_before_usd_cents).toBe(0);expect(receipt.balance_after_usd_cents).toBe(500);
  },30000);
  test('different funding intents serialize on one owner wallet',async()=>{
    const rows=await Promise.all([intent(),intent()]);await Promise.all(rows.map(row=>service().completeSuccessfulFunding(row.id,proof(row))));const wallet=(await pool.query('select * from billing_wallets')).rows[0];expect(wallet.balance_usd_cents).toBe(1000);expect(wallet.version).toBe(2);
  });
  test('receipt storage failure rolls back the wallet and retry credits once',async()=>{
    const row=await intent();await pool.query("create function reject_receipt() returns trigger language plpgsql as $$ begin if new.status='completed' then raise exception 'injected receipt failure'; end if; return new; end $$");
    await pool.query('create trigger fail_receipt before update on billing_transactions for each row execute function reject_receipt()');
    try {await expect(service().completeSuccessfulFunding(row.id,proof(row))).rejects.toThrow();expect((await pool.query('select count(*)::int count from billing_wallets')).rows[0].count).toBe(0);expect((await pool.query('select status from billing_transactions')).rows[0].status).toBe('pending');}
    finally {await pool.query('drop trigger fail_receipt on billing_transactions');await pool.query('drop function reject_receipt()');}
    await service().completeSuccessfulFunding(row.id,proof(row));expect((await pool.query('select balance_usd_cents from billing_wallets')).rows[0].balance_usd_cents).toBe(500);
  });
  test('database reference uniqueness rejects a second intent independently of application checks',async()=>{
    const row=await intent();await expect(pool.query("insert into billing_transactions(user_id,type,status,amount_usd_cents,reference) values($1,'wallet_fund','pending',500,$2)",[owner,row.reference])).rejects.toMatchObject({code:'23505'});
  });
  test('concurrent initialization across instances calls provider only once',async()=>{
    const psp=provider(),requestId=randomUUID();const settled=await Promise.allSettled(Array.from({length:6},()=>service(psp).initializeFunding({userId:owner,userEmail:'owner@example.test',requestId,amountUsd:5})));
    expect(settled.every(item=>item.status==='fulfilled')).toBe(true);const results=settled.map(item=>(item as PromiseFulfilledResult<any>).value);
    expect(psp.initializeTransaction).toHaveBeenCalledTimes(1);expect(new Set(results.map(row=>row.reference)).size).toBe(1);expect((await pool.query('select count(*)::int count from billing_transactions')).rows[0].count).toBe(1);expect(await service(psp).recoverFundingRequest(owner,requestId)).toMatchObject({checkoutReady:true});
  });
  test('provider ambiguity persists across a new service instance without replay',async()=>{
    const psp=provider();psp.initializeTransaction.mockRejectedValue(Error('lost provider response'));const requestId=randomUUID();await expect(service(psp).initializeFunding({userId:owner,userEmail:'owner@example.test',requestId,amountUsd:5})).rejects.toThrow();
    expect(await service(psp).initializeFunding({userId:owner,userEmail:'owner@example.test',requestId,amountUsd:5})).toMatchObject({checkoutReady:false,status:'pending'});expect(psp.initializeTransaction).toHaveBeenCalledTimes(1);
  });
  test('held real advisory lock times out without money writes',async()=>{
    const row=await intent(),connection=await pool.connect();await connection.query('begin');await connection.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['wallet-fund:'+row.id]);
    try {await expect(service().completeSuccessfulFunding(row.id,proof(row))).rejects.toThrow();expect((await pool.query('select count(*)::int count from billing_wallets')).rows[0].count).toBe(0);} finally {await connection.query('rollback');connection.release();}
  },15000);
  const hash = (value:string) => createHash('sha256').update(value).digest('hex');
  const tokens = () => new TokensService(db,new JwtService());
  async function seedSession() {
    const appId=randomUUID(),familyId=randomUUID(),raw='fixture-'+randomUUID();
    await pool.query('insert into apps(id) values($1)',[appId]);
    await db.insert(schema.refreshTokens).values({userId:owner,appId,familyId,tokenHash:hash(raw),deviceFingerprint:'fixture-device',expiresAt:new Date(Date.now()+86400_000)});
    return {raw,appId,familyId};
  }
  async function liveTokens(familyId:string) {return (await pool.query('select * from refresh_tokens where family_id=$1 and revoked_at is null',[familyId])).rows;}
  test('concurrent refresh issues one successor and returns bounded collisions to losers',async()=>{
    const session=await seedSession();const results=await Promise.allSettled(Array.from({length:6},()=>tokens().rotateRefreshToken(session.raw)));
    expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    for(const item of results)if(item.status==='rejected')expect(item.reason.getStatus()).toBe(409);
    expect(await liveTokens(session.familyId)).toHaveLength(1);expect((await pool.query('select count(*)::int count from refresh_tokens')).rows[0].count).toBe(2);
    expect((await liveTokens(session.familyId))[0]).toMatchObject({app_id:session.appId,device_fingerprint:'fixture-device'});
  });
  test('concurrent logout and rotation leave no live descendant regardless of winner',async()=>{
    const session=await seedSession();const results=await Promise.allSettled([tokens().rotateRefreshToken(session.raw),tokens().revokeRefreshToken(session.raw,owner)]);
    expect(results[1].status).toBe('fulfilled');expect(await liveTokens(session.familyId)).toHaveLength(0);
  });
  test('refresh insert failure rolls back consumption so explicit retry can rotate',async()=>{
    const session=await seedSession();await pool.query("create function reject_refresh_insert() returns trigger language plpgsql as $$ begin raise exception 'injected token insert failure'; end $$");await pool.query('create trigger reject_refresh before insert on refresh_tokens for each row execute function reject_refresh_insert()');
    try {await expect(tokens().rotateRefreshToken(session.raw)).rejects.toThrow();expect(await liveTokens(session.familyId)).toHaveLength(1);}
    finally {await pool.query('drop trigger reject_refresh on refresh_tokens');await pool.query('drop function reject_refresh_insert()');}
    await tokens().rotateRefreshToken(session.raw);expect(await liveTokens(session.familyId)).toHaveLength(1);
  });
  test('late replay commits family revocation and does not revoke another family',async()=>{
    const session=await seedSession(),other=await seedSession();await tokens().rotateRefreshToken(session.raw);
    await pool.query("update refresh_tokens set revoked_at=now()-interval '11 seconds' where token_hash=$1",[hash(session.raw)]);
    await expect(tokens().rotateRefreshToken(session.raw)).rejects.toMatchObject({status:401});
    expect(await liveTokens(session.familyId)).toHaveLength(0);expect(await liveTokens(other.familyId)).toHaveLength(1);
  });
  test('suspended account revocation commits, foreign-owner logout cannot revoke',async()=>{
    const session=await seedSession();await expect(tokens().revokeRefreshToken(session.raw,randomUUID())).rejects.toMatchObject({status:401});expect(await liveTokens(session.familyId)).toHaveLength(1);
    await pool.query("update users set status='SUSPENDED' where id=$1",[owner]);await expect(tokens().rotateRefreshToken(session.raw)).rejects.toMatchObject({status:401});expect(await liveTokens(session.familyId)).toHaveLength(0);
  });
  test('refresh and logout respect real advisory lock timeout without consuming tokens',async()=>{
    const session=await seedSession(),connection=await pool.connect();await connection.query('begin');await connection.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['crimfig-refresh:'+session.familyId]);
    try {const results=await Promise.allSettled([tokens().rotateRefreshToken(session.raw),tokens().revokeRefreshToken(session.raw,owner)]);expect(results.every(item=>item.status==='rejected')).toBe(true);expect(await liveTokens(session.familyId)).toHaveLength(1);}
    finally {await connection.query('rollback');connection.release();}
  },15000);
  async function campaign(balance=2000) {
    const [row]=await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Fixture',budgetUsdCents:1000,remainingBudgetUsdCents:1000,status:'paused',moderationStatus:'approved'}).returning();
    await db.insert(schema.billingWallets).values({userId:owner,balanceUsdCents:balance});return row;
  }
  const escrow = () => new CampaignEscrowService(db);
  test('PLAN0099 Trash and Restore serialize without posting a ledger entry', async () => {
    const [draft] = await db.insert(schema.adsCampaigns).values({
      advertiserId:owner, title:'Trash fixture', budgetUsdCents:1000, remainingBudgetUsdCents:1000,
      status:'draft', moderationStatus:'draft',
    }).returning();
    await expect(escrow().change(randomUUID(),draft.id,'release',undefined,'trash')).rejects.toMatchObject({status:404});
    const trash = await Promise.all(Array.from({length:4},()=>escrow().change(owner,draft.id,'release',undefined,'trash')));
    expect(trash.every(result=>result.campaign.status==='trash' && result.operationId===null)).toBe(true);
    await expect(escrow().change(owner,draft.id,'release',undefined,'paused')).rejects.toMatchObject({status:409});
    const restored = await Promise.all(Array.from({length:4},()=>escrow().change(owner,draft.id,'release',undefined,'draft')));
    expect(restored.every(result=>result.campaign.status==='draft' && result.operationId===null)).toBe(true);
    expect((await pool.query('select status, moderation_status from ads_campaigns where id=$1',[draft.id])).rows[0]).toEqual({status:'draft',moderation_status:'draft'});
    expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(0);
  });
  test('concurrent owner activations commit one debit, escrow and campaign status',async()=>{
    const row=await campaign();const results=await Promise.allSettled(Array.from({length:6},()=>escrow().change(owner,row.id,'reserve',undefined,'active')));
    expect(results.every(item=>item.status==='fulfilled')).toBe(true);expect((await pool.query('select balance_usd_cents from billing_wallets')).rows[0].balance_usd_cents).toBe(1000);
    expect((await pool.query('select count(*)::int count from ads_campaign_escrows')).rows[0].count).toBe(1);expect((await pool.query('select status from ads_campaigns')).rows[0].status).toBe('active');expect((await pool.query('select count(*)::int count from billing_transactions')).rows[0].count).toBe(1);
    await Promise.all(Array.from({length:4},()=>escrow().change(owner,row.id,'release',undefined,'paused')));expect((await pool.query('select balance_usd_cents from billing_wallets')).rows[0].balance_usd_cents).toBe(2000);expect((await pool.query('select count(*)::int count from billing_transactions')).rows[0].count).toBe(2);
  });
  test('competing campaigns cannot overdraw one advertiser wallet',async()=>{
    const first=await campaign(1500);const [second]=await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Second fixture',budgetUsdCents:1000,remainingBudgetUsdCents:1000,status:'paused',moderationStatus:'approved'}).returning();
    const results=await Promise.allSettled([first,second].map(row=>escrow().change(owner,row.id,'reserve',undefined,'active')));expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);expect((await pool.query('select balance_usd_cents from billing_wallets')).rows[0].balance_usd_cents).toBe(500);expect((await pool.query('select count(*)::int count from ads_campaign_escrows')).rows[0].count).toBe(1);
  });
  test('campaign write failure rolls back debit, escrow and receipt together',async()=>{
    const row=await campaign();await pool.query("create function reject_campaign_status() returns trigger language plpgsql as $$ begin if new.status='active' then raise exception 'injected status failure'; end if; return new; end $$");await pool.query('create trigger reject_campaign before update on ads_campaigns for each row execute function reject_campaign_status()');
    try {await expect(escrow().change(owner,row.id,'reserve',undefined,'active')).rejects.toThrow();expect((await pool.query('select balance_usd_cents from billing_wallets')).rows[0].balance_usd_cents).toBe(2000);expect((await pool.query('select count(*)::int count from ads_campaign_escrows')).rows[0].count).toBe(0);expect((await pool.query('select count(*)::int count from billing_transactions')).rows[0].count).toBe(0);}
    finally {await pool.query('drop trigger reject_campaign on ads_campaigns');await pool.query('drop function reject_campaign_status()');}
  });

  const withdrawalLedger = () => new WithdrawalLedgerService(db, { paymentDomain: () => 'test' } as any, new ExchangeRateService(db));
  async function withdrawalFixture() {
    const reference = 'withdrawal_' + randomUUID().replace(/-/g, '');
    const [bank] = await db.insert(schema.billingBankAccounts).values({userId:owner,bankName:'Test Bank',bankCode:'000',accountNumber:'0000000000',accountName:'Synthetic Test',isVerified:true,recipientCode:'RCP_fixture'}).returning();
    const [receipt] = await db.insert(schema.billingTransactions).values({userId:owner,type:'wallet_withdraw',status:'pending',provider:'paystack',reference,amountUsdCents:500,amountNgnKobo:50000,exchangeRateId:rateId,metadata:JSON.stringify({withdrawalVersion:2,domain:'test',recipientCode:'RCP_fixture',bankAccountId:bank.id})}).returning();
    await db.insert(schema.billingWithdrawalRequests).values({userId:owner,amountUsdCents:500,amountNgnKobo:50000,exchangeRateId:rateId,bankAccountId:bank.id,transactionId:receipt.id,paystackTransferReference:reference,status:'processing'});
    await db.insert(schema.billingWallets).values({userId:owner,balanceUsdCents:100,lockedUsdCents:1200});
    return {reference,proof:{reference,amount:50000,currency:'NGN',domain:'test',recipient:{recipient_code:'RCP_fixture'},transfer_code:'TRF_fixture',status:'success'}};
  }
  const withdrawalWallet = async () => (await pool.query('select balance_usd_cents available,locked_usd_cents locked from billing_wallets')).rows[0];
  test('concurrent transfer success consumes one reserve and reversal refunds once without another reserve',async()=>{
    const {reference,proof}=await withdrawalFixture();
    await Promise.all(Array.from({length:5},()=>withdrawalLedger().complete(reference,proof)));
    expect(await withdrawalWallet()).toEqual({available:100,locked:700});
    await Promise.all(Array.from({length:5},()=>withdrawalLedger().complete(reference,{...proof,status:'reversed'})));
    expect(await withdrawalWallet()).toEqual({available:600,locked:700});
    expect((await pool.query('select status from billing_transactions')).rows[0].status).toBe('reversed');
  });
  test('transfer failure/reversal overlap releases reserved principal only once',async()=>{
    const {reference,proof}=await withdrawalFixture();
    await Promise.allSettled(['failed','reversed','failed','reversed'].map(status=>withdrawalLedger().complete(reference,{...proof,status})));
    expect(await withdrawalWallet()).toEqual({available:600,locked:700});
    await expect(withdrawalLedger().complete(reference,proof)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({available:600,locked:700});
  });
  test('mismatched provider recipient cannot move a reserved withdrawal',async()=>{
    const {reference,proof}=await withdrawalFixture();
    await expect(withdrawalLedger().complete(reference,{...proof,recipient:{recipient_code:'RCP_foreign'}})).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({available:100,locked:1200});
    expect((await pool.query('select status from billing_transactions')).rows[0].status).toBe('pending');
  });
  test('withdrawal receipt failure rolls back wallet and request before an explicit completion retry',async()=>{
    const {reference,proof}=await withdrawalFixture();
    await pool.query("create function reject_withdrawal_receipt() returns trigger language plpgsql as $$ begin if new.type='wallet_withdraw' and new.status='completed' then raise exception 'injected receipt failure'; end if; return new; end $$");
    await pool.query('create trigger reject_withdrawal_receipt before update on billing_transactions for each row execute function reject_withdrawal_receipt()');
    try {
      await expect(withdrawalLedger().complete(reference,proof)).rejects.toThrow();
      expect(await withdrawalWallet()).toEqual({available:100,locked:1200});
      expect((await pool.query('select status from billing_withdrawal_requests')).rows[0].status).toBe('processing');
    } finally {await pool.query('drop trigger reject_withdrawal_receipt on billing_transactions');await pool.query('drop function reject_withdrawal_receipt()');}
    await withdrawalLedger().complete(reference,proof);expect(await withdrawalWallet()).toEqual({available:100,locked:700});
  });

  async function reservableWithdrawal(balance=1500) {
    const [bank] = await db.insert(schema.billingBankAccounts).values({userId:owner,bankName:'Fixture',bankCode:'000',accountNumber:'0000000000',accountName:'Synthetic',isVerified:true,recipientCode:'RCP_fixture'}).returning();
    await pool.query('update billing_exchange_rates set raw_main_response=$1,fetched_at=now()',[JSON.stringify({result:'success',base_code:'USD',rates:{NGN:100},time_last_update_unix:Math.floor(Date.now()/1000)})]);
    await db.insert(schema.billingWallets).values({userId:owner,balanceUsdCents:balance});
    return bank.id;
  }
  test('concurrent quotes are durable, reserve no funds and bind exact net payout on confirmation', async () => {
    const bank = await reservableWithdrawal(), request = randomUUID();
    const quotes = await Promise.all(Array.from({ length: 4 }, () => withdrawalLedger().quote(owner, request, bank, 500)));
    expect(new Set(quotes.map(q => q.quoteId)).size).toBe(1);
    const q = quotes[0];
    expect(q).toMatchObject({ grossKobo: 50000, netKobo: 49000, transferFeeKobo: 1000, stampDutyKobo: 0 });
    expect(await withdrawalWallet()).toEqual({ available: 1500, locked: 0 });
    await Promise.all(Array.from({ length: 4 }, () => withdrawalLedger().reserve(owner, request, bank, 500, q.quoteId)));
    expect(await withdrawalWallet()).toEqual({ available: 1000, locked: 500 });
    const rows = (await pool.query('select amount_ngn_kobo,metadata from billing_transactions')).rows;
    expect(rows).toHaveLength(1); expect(rows[0].amount_ngn_kobo).toBe(49000);
    expect(JSON.parse(rows[0].metadata).payoutQuote.quoteId).toBe(q.quoteId);
  });
  test.each(['failed','reversed'])('quoted %s refund deducts only reviewed retained charges exactly once', async outcome => {
    const bank = await reservableWithdrawal(), request = randomUUID(), ledger = withdrawalLedger();
    const q = await ledger.quote(owner, request, bank, 500);
    const reserved = await ledger.reserve(owner, request, bank, 500, q.quoteId);
    const proof = {reference:reserved.reference,amount:q.netKobo,currency:'NGN',domain:'test',recipient:{recipient_code:'RCP_fixture'},transfer_code:'TRF_quoted',status:outcome};
    await ledger.dispatchIntent(owner,reserved.reference,true);
    if (outcome === 'reversed') await ledger.complete(reserved.reference,{...proof,status:'success'});
    const before = await withdrawalWallet();
    await expect(ledger.complete(reserved.reference,proof)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual(before);
    await db.insert(schema.billingProviderEvents).values({provider:'paystack',reference:`internal.withdrawal.refund:${reserved.reference}`,eventType:'internal.withdrawal.refund',processed:true,
      rawPayload:{version:2,reviewKind:'independent-authenticated-operators',reference:reserved.reference,domain:'test',currency:'NGN',transferCode:'TRF_quoted',outcome,quoteId:q.quoteId,providerEvidenceId:'synthetic-ledger-evidence',preparedBy:'reviewer-one',reviewedBy:'reviewer-two',retainedFeeKobo:1000,retainedStampDutyKobo:0}});
    await Promise.all(Array.from({length:4},()=>ledger.complete(reserved.reference,proof)));
    expect(await withdrawalWallet()).toEqual({available:1490,locked:0});
    const receipt=(await pool.query('select metadata from billing_transactions')).rows[0];
    expect(JSON.parse(receipt.metadata).refundReconciliation).toMatchObject({retainedKobo:1000,retainedUsdCents:10,refundUsdCents:490});
  });

  test('refund review requires two active granted identities and immutable provider-bound draft', async () => {
    const bank=await reservableWithdrawal(), ledger=withdrawalLedger(), request=randomUUID();
    const q=await ledger.quote(owner,request,bank,500);
    const reserved=await ledger.reserve(owner,request,bank,500,q.quoteId);
    await ledger.dispatchIntent(owner,reserved.reference,true);
    const one=randomUUID(),two=randomUUID();
    await pool.query("insert into users(id,email,status) values($1,'one@fixture.invalid','ACTIVE'),($2,'two@fixture.invalid','ACTIVE')",[one,two]);
    const proof={reference:reserved.reference,amount:q.netKobo,currency:'NGN',domain:'test',recipient:{recipient_code:'RCP_fixture'},transfer_code:'TRF_review',status:'failed'};
    const provider:any={paymentDomain:()=> 'test',verifyTransfer:jest.fn(async()=>proof)};
    const service=new RefundReviewService(db,provider,{get:()=>JSON.stringify([one,two])} as any);
    const input={providerEvidenceId:'synthetic-provider-balance-record',retainedFeeKobo:1000,retainedStampDutyKobo:0};
    await expect(service.prepare(owner,reserved.reference,input)).rejects.toThrow('Finance operator');
    expect(provider.verifyTransfer).not.toHaveBeenCalled();
    await expect(service.prepare(one,reserved.reference,{...input,retainedFeeKobo:1001})).rejects.toThrow('Charges exceed');
    const selfService=new RefundReviewService(db,provider,{get:()=>JSON.stringify([owner,one,two])} as any);
    await expect(selfService.prepare(owner,reserved.reference,input)).rejects.toThrow('own withdrawals');
    const draft=await service.prepare(one,reserved.reference,input);
    await expect(service.prepare(one,reserved.reference,input)).rejects.toThrow('already prepared');
    proof.status='success';
    await expect(service.approve(two,reserved.reference,draft.draftId)).rejects.toThrow('failed or reversed');
    proof.status='failed';
    await expect(service.approve(one,reserved.reference,draft.draftId)).rejects.toThrow('Independent reviewer');
    await expect(service.approve(two,reserved.reference,randomUUID())).rejects.toThrow('exact current');
    await expect(ledger.complete(reserved.reference,proof)).rejects.toThrow();
    await pool.query("update users set status='SUSPENDED' where id=$1",[one]);
    await expect(service.approve(two,reserved.reference,draft.draftId)).rejects.toThrow('Active finance');
    await pool.query("update users set status='ACTIVE' where id=$1",[one]);
    await Promise.all(Array.from({length:3},()=>service.approve(two,reserved.reference,draft.draftId)));
    await ledger.complete(reserved.reference,proof);
    expect(await withdrawalWallet()).toEqual({available:1490,locked:0});
    expect((await service.read(two,reserved.reference)).evidence).toMatchObject({preparedBy:one,reviewedBy:two});
    const recovery=await new WithdrawalDispatchService(ledger,provider).recover(owner,reserved.reference);
    expect(recovery).toMatchObject({status:'failed',refund:{grossUsdCents:500,refundUsdCents:490,retainedUsdCents:10,retainedKobo:1000}});
  });

  test('wrong quote confirmation and changed details cannot reserve funds', async () => {
    const bank = await reservableWithdrawal(), request = randomUUID();
    const q = await withdrawalLedger().quote(owner, request, bank, 500);
    await expect(withdrawalLedger().reserve(owner, request, bank, 500, randomUUID())).rejects.toThrow();
    await expect(withdrawalLedger().reserve(owner, request, bank, 600, q.quoteId)).rejects.toThrow();
    await expect(withdrawalLedger().quote(owner, request, bank, 600)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({ available: 1500, locked: 0 });
  });
  test('recipient changes invalidate reviewed quotes without touching wallet balances', async () => {
    const bank = await reservableWithdrawal(), request = randomUUID();
    const q = await withdrawalLedger().quote(owner, request, bank, 500);
    await pool.query('update billing_bank_accounts set recipient_code=$1 where id=$2', ['RCP_changed', bank]);
    await expect(withdrawalLedger().reserve(owner, request, bank, 500, q.quoteId)).rejects.toThrow('Recipient changed');
    expect(await withdrawalWallet()).toEqual({ available: 1500, locked: 0 });
  });

  test('expired quote requires a new review and cannot reserve money', async () => {
    const bank = await reservableWithdrawal(), request = randomUUID();
    const q = await withdrawalLedger().quote(owner, request, bank, 500);
    await pool.query('update billing_provider_events set raw_payload=$1', [JSON.stringify({ ...q, expiresAt: new Date(0).toISOString() })]);
    await expect(withdrawalLedger().reserve(owner, request, bank, 500, q.quoteId)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({ available: 1500, locked: 0 });
  });

  test('concurrent duplicate withdrawal requests reserve once and bind immutable details',async()=>{
    const bank=await reservableWithdrawal(),request=randomUUID();
    const results=await Promise.all(Array.from({length:5},()=>withdrawalLedger().reserve(owner,request,bank,500)));
    expect(new Set(results.map(result=>result.withdrawalId)).size).toBe(1);
    expect(await withdrawalWallet()).toEqual({available:1000,locked:500});
    expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(1);
    await expect(withdrawalLedger().reserve(owner,request,bank,600)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({available:1000,locked:500});
  });
  test('competing withdrawals cannot overdraw one wallet',async()=>{
    const bank=await reservableWithdrawal(700);
    const results=await Promise.allSettled([withdrawalLedger().reserve(owner,randomUUID(),bank,500),withdrawalLedger().reserve(owner,randomUUID(),bank,500)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(await withdrawalWallet()).toEqual({available:200,locked:500});
  });
  test('stale FX or foreign bank cannot reserve funds',async()=>{
    const bank=await reservableWithdrawal();
    await expect(withdrawalLedger().reserve(owner,randomUUID(),randomUUID(),500)).rejects.toThrow();
    await pool.query("update billing_exchange_rates set fetched_at=now()-interval '25 hours'");
    await expect(withdrawalLedger().reserve(owner,randomUUID(),bank,500)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({available:1500,locked:0});
    expect((await pool.query('select count(*)::int n from billing_transactions')).rows[0].n).toBe(0);
  });

  test('suspended account cannot create a withdrawal reservation',async()=>{
    const bank=await reservableWithdrawal();await pool.query("update users set status='SUSPENDED' where id=$1",[owner]);
    await expect(withdrawalLedger().reserve(owner,randomUUID(),bank,500)).rejects.toThrow();
    expect(await withdrawalWallet()).toEqual({available:1500,locked:0});
  });

  test('concurrent withdrawal dispatch calls provider once and recovery never sends another payout',async()=>{
    const bank=await reservableWithdrawal();const reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    const proof={reference:reserved.reference,amount:50000,currency:'NGN',domain:'test',recipient:{recipient_code:'RCP_fixture'},transfer_code:'TRF_fixture',status:'pending'};
    const provider:any={initiateTransfer:jest.fn(async()=>proof),verifyTransfer:jest.fn(async()=>({...proof,status:'success'}))};
    const dispatcher=()=>new WithdrawalDispatchService(withdrawalLedger(),provider);
    await Promise.all(Array.from({length:5},()=>dispatcher().dispatch(owner,reserved.reference)));
    expect(provider.initiateTransfer).toHaveBeenCalledTimes(1);expect(await withdrawalWallet()).toEqual({available:1000,locked:500});
    const result=await dispatcher().recover(owner,reserved.reference);expect(result.status).toBe('completed');
    expect(provider.initiateTransfer).toHaveBeenCalledTimes(1);expect(provider.verifyTransfer).toHaveBeenCalledTimes(1);
    expect(await withdrawalWallet()).toEqual({available:1000,locked:0});
  });
  test('lost transfer initialization acknowledgement stays reserved across new instances without replay',async()=>{
    const bank=await reservableWithdrawal();const reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    const provider:any={initiateTransfer:jest.fn(async()=>{throw Error('lost acknowledgement');}),verifyTransfer:jest.fn(async()=>{throw Error('not found is not absence proof');})};
    await new WithdrawalDispatchService(withdrawalLedger(),provider).dispatch(owner,reserved.reference);
    await new WithdrawalDispatchService(withdrawalLedger(),provider).dispatch(owner,reserved.reference);
    await new WithdrawalDispatchService(withdrawalLedger(),provider).recover(owner,reserved.reference);
    expect(provider.initiateTransfer).toHaveBeenCalledTimes(1);expect(await withdrawalWallet()).toEqual({available:1000,locked:500});
    await expect(new WithdrawalDispatchService(withdrawalLedger(),provider).recover(randomUUID(),reserved.reference)).rejects.toThrow();
    expect(provider.verifyTransfer).toHaveBeenCalledTimes(1);
  });
  test('callback before dispatch acknowledgement cannot be overwritten with pending',async()=>{
    const bank=await reservableWithdrawal();const reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    const proof={reference:reserved.reference,amount:50000,currency:'NGN',domain:'test',recipient:{recipient_code:'RCP_fixture'},transfer_code:'TRF_fixture',status:'success'};
    const provider:any={initiateTransfer:jest.fn(async()=>{await withdrawalLedger().complete(reserved.reference,proof);return {...proof,status:'pending'};})};
    const result=await new WithdrawalDispatchService(withdrawalLedger(),provider).dispatch(owner,reserved.reference);
    expect(result.status).toBe('completed');expect(await withdrawalWallet()).toEqual({available:1000,locked:0});
  });

  test('duplicate cancellation refunds only an undispatched owned withdrawal once',async()=>{
    const bank=await reservableWithdrawal(),reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    await expect(withdrawalLedger().cancel(randomUUID(),reserved.reference)).rejects.toThrow();
    await Promise.all(Array.from({length:5},()=>withdrawalLedger().cancel(owner,reserved.reference)));
    expect(await withdrawalWallet()).toEqual({available:1500,locked:0});
    const claim=await withdrawalLedger().dispatchIntent(owner,reserved.reference,true);expect(claim.claimed).toBe(false);
    expect(claim.status).toBe('cancelled');
  });
  test('cancellation and dispatch ownership race cannot both refund and send',async()=>{
    const bank=await reservableWithdrawal(),reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    const results=await Promise.allSettled([withdrawalLedger().cancel(owner,reserved.reference),withdrawalLedger().dispatchIntent(owner,reserved.reference,true)]);
    const dispatch=results[1];expect(dispatch.status).toBe('fulfilled');
    if(dispatch.status==='fulfilled' && dispatch.value.claimed){
      expect(results[0].status).toBe('rejected');expect(await withdrawalWallet()).toEqual({available:1000,locked:500});
      await expect(withdrawalLedger().cancel(owner,reserved.reference)).rejects.toThrow();
    }else{expect(results[0].status).toBe('fulfilled');expect(await withdrawalWallet()).toEqual({available:1500,locked:0});}
  });

  const withdrawalHooks=()=>new WebhooksService(db,{verifyWebhookSignature:()=>true} as any,{} as any,withdrawalLedger());
  test('duplicate transfer callbacks use one ledger effect and separate event-type receipts',async()=>{
    const {reference,proof}=await withdrawalFixture();
    await Promise.all(Array.from({length:4},()=>withdrawalHooks().handlePaystackWebhook(JSON.stringify({event:'transfer.success',data:proof}),'synthetic')));
    expect(await withdrawalWallet()).toEqual({available:100,locked:700});
    await withdrawalHooks().handlePaystackWebhook(JSON.stringify({event:'transfer.reversed',data:{...proof,status:'reversed'}}),'synthetic');
    expect(await withdrawalWallet()).toEqual({available:600,locked:700});
    const events=(await pool.query('select event_type,processed from billing_provider_events order by event_type')).rows;
    expect(events).toHaveLength(2);expect(events.every((event:any)=>event.processed)).toBe(true);
  });
  test('transfer callback acknowledgement failure does not undo or repeat a committed receipt',async()=>{
    const {proof}=await withdrawalFixture();const body=JSON.stringify({event:'transfer.success',data:proof});
    await pool.query("create function reject_transfer_ack() returns trigger language plpgsql as $$ begin if new.processed then raise exception 'injected ack failure'; end if; return new; end $$");
    await pool.query('create trigger reject_transfer_ack before update on billing_provider_events for each row execute function reject_transfer_ack()');
    try {
      await expect(withdrawalHooks().handlePaystackWebhook(body,'synthetic')).rejects.toThrow();
      expect(await withdrawalWallet()).toEqual({available:100,locked:700});
      expect((await pool.query('select processed from billing_provider_events')).rows[0].processed).toBe(false);
    }finally{await pool.query('drop trigger reject_transfer_ack on billing_provider_events');await pool.query('drop function reject_transfer_ack()');}
    await withdrawalHooks().handlePaystackWebhook(body,'synthetic');expect(await withdrawalWallet()).toEqual({available:100,locked:700});
    expect((await pool.query('select processed from billing_provider_events')).rows[0].processed).toBe(true);
  });

  test('recipient verification revoked after reservation cannot acquire dispatch ownership',async()=>{
    const bank=await reservableWithdrawal(),reserved=await withdrawalLedger().reserve(owner,randomUUID(),bank,500);
    await pool.query('update billing_bank_accounts set is_verified=false where id=$1',[bank]);
    await expect(withdrawalLedger().dispatchIntent(owner,reserved.reference,true)).rejects.toThrow();
    expect((await withdrawalLedger().dispatchIntent(owner,reserved.reference,false)).dispatchStarted).toBe(false);
    await withdrawalLedger().cancel(owner,reserved.reference);expect(await withdrawalWallet()).toEqual({available:1500,locked:0});
  });

  test.each(['callback-first','webhook-first','concurrent'])('verified funding callback and webhook credit once: %s',async order=>{
    const row=await intent();
    const psp:any={paymentDomain:()=> 'test',verifyTransaction:jest.fn(async()=>proof(row)),verifyWebhookSignature:()=>true};
    const wallet=service(psp),hooks=new WebhooksService(db,psp,wallet);
    const callback=()=>wallet.verifyFunding(row.reference,owner);
    const webhook=()=>hooks.handlePaystackWebhook(JSON.stringify({event:'charge.success',data:proof(row)}),'synthetic');
    if(order==='callback-first'){await callback();await webhook();}
    else if(order==='webhook-first'){await webhook();await callback();expect(psp.verifyTransaction).not.toHaveBeenCalled();}
    else await Promise.all([callback(),webhook()]);
    await callback();await webhook();
    const balance=(await pool.query('select balance_usd_cents,version from billing_wallets')).rows[0];
    expect(balance).toEqual({balance_usd_cents:500,version:1});
    const receipt=(await pool.query('select idempotency_key,status from billing_transactions')).rows[0];
    expect(receipt).toEqual({idempotency_key:'wallet-fund:v2:'+row.id,status:'completed'});
    expect((await pool.query('select count(*)::int n from billing_provider_events where processed')).rows[0].n).toBe(1);
  });

});
