import { AdClearanceService } from '../../../api/billing-api/src/modules/ecosystem/ad-clearance.service';
import { AdSettlementService } from '../../../api/billing-api/src/modules/ecosystem/ad-settlement.service';
import { SubscriptionPaymentsService } from '../../../api/billing-api/src/modules/subscriptions/subscription-payments.service';
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
import * as schema from '@crimfig/database/schema';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';

jest.mock('../../src/config/config', () => ({ config: { JWT: { ACCESS_SECRET: 'postgres-test-only-signing-secret', ACCESS_EXPIRES_IN: '2m', REFRESH_EXPIRES_DAYS: 30 } } }));

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
    pool = new Pool({ connectionString: url.href, max: 12, connectionTimeoutMillis: 3000 });
    db = drizzle(pool, { schema });
    await pool.query('create table users(id uuid primary key,email text not null,status text not null)');
    await pool.query('create table apps(id uuid primary key)');
    // Actual Drizzle columns/defaults/enums/unique constraints/FKs, not the serialized mock adapter.
    // User identity is a minimal FK fixture; no production migrations or existing records are used.
    const tables = [schema.billingExchangeRates, schema.billingWallets, schema.billingTransactions, schema.billingSavedCards, schema.billingProviderEvents, schema.refreshTokens, schema.adsCampaigns, schema.adsCampaignEscrows, schema.billingBankAccounts, schema.billingWithdrawalRequests, schema.billingSubscriptions, schema.adsCreatives, schema.adsPromoters, schema.adsPromoterWebsites, schema.adsPromoterApps, schema.adsPlacements, schema.adsServes, schema.adsInteractions, schema.adsSettlementBatches, schema.adsPromoterSettlementItems, schema.adsSettlementClaims, schema.adsSettlementCarries];
    const enums = new Set<string>();
    for (const table of tables) for (const col of getTableConfig(table).columns as any[]) {
      if (col.enum && !enums.has(col.enum.enumName)) {
        enums.add(col.enum.enumName); await pool.query(`create type ${quote(col.enum.enumName)} as enum (${col.enum.enumValues.map(literal).join(',')})`);
      }
    }
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = config.columns.map((col: any) => `${quote(col.name)} ${col.getSQLType()}${col.primary?' primary key':''}${col.notNull?' not null':''}${col.isUnique?' unique':''}${col.default!==undefined?' default '+defaultSql(col.default):''}`);
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
  const fx = () => ({getUsdToNgnRate:async()=>({rateId,rate:100}),convertUsdCentsToNgn:async(cents:number)=>({ngnKobo:cents*100})});
  const provider = () => ({paymentDomain:()=> 'test',initializeTransaction:jest.fn(async (input:any)=>({reference:input.reference,authorization_url:'https://checkout.paystack.com/fixture',access_code:'fixture'}))});
  const service = (psp:any=provider()) => new WalletService(db,fx() as any,psp);
  async function intent(cents=500) {
    const [row]=await db.insert(schema.billingTransactions).values({userId:owner,type:'wallet_fund',status:'pending',provider:'paystack',reference:'fixture-'+randomUUID(),amountUsdCents:cents,amountNgnKobo:cents*100,exchangeRateId:rateId,metadata:JSON.stringify({fundingVersion:2,expectedEmail:'owner@example.test',saveCard:false})}).returning();return row;
  }
  const proof = (row:any) => ({reference:row.reference,status:'success',currency:'NGN',domain:'test',amount:row.amountNgnKobo,metadata:{transactionId:row.id,userId:owner},customer:{email:'owner@example.test'}});
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
  async function settlementFixture(price = 100_000_000n, model = 'cpc') {
    const [campaign] = await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Versioned settlement fixture',budgetUsdCents:1000,
      remainingBudgetUsdCents:1000,status:'paused',moderationStatus:'approved',pricingVersion:2,pricingModel:model}).returning();
    await db.insert(schema.billingWallets).values({userId:owner,balanceUsdCents:2000});
    await new CampaignEscrowService(db).change(owner,campaign.id,'reserve',undefined,'active');
    const publisher=randomUUID();await pool.query("insert into users(id,email,status) values($1,'publisher@example.test','ACTIVE')",[publisher]);
    const [promoter]=await db.insert(schema.adsPromoters).values({userId:publisher,type:'INDIVIDUAL'}).returning();
    const [creative]=await db.insert(schema.adsCreatives).values({campaignId:campaign.id,headline:'Reviewed',destinationUrl:'https://example.test',status:'active',reviewStatus:'approved'}).returning();
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
