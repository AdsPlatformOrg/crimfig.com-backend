import 'reflect-metadata';
import { tap } from 'rxjs/operators';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import * as schema from '@crimfig/database/schema';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { ModerationController } from '../../../api/ads-api/src/modules/moderation/moderation.controller';
import { AdsAccessGuard } from '../../../api/ads-api/src/modules/security/ads-access.guard';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { CampaignWorkflow } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
let service:ModerationService;
@Module({controllers:[ModerationController],providers:[{provide:ModerationService,useFactory:()=>service}]})class LocalModule{}
const run=process.env.PLAN0009_PG_URL?describe:describe.skip;
run('PLAN0077 real local HTTP + PostgreSQL moderation (no Redis/provider boundary)',()=>{
 let pool:Pool,db:any,app:any,origin:string,owner:string,reviewer:string,manager:string,outsider:string,ids:any;
 const roles=new Map<string,string[]>(),jwt=new JwtService({secret:'plan0077-disposable-test-only-secret'});
 const grants={rolesFor:(id:string)=>roles.get(id)||[]} as unknown as AdsStaffGrants;
 const artifact:any={};
 async function request(path:string,actor?:string,body?:any,drop=false):Promise<{status:number;body:any}>{const response=await fetch(origin+'/api/v1/admin/ads/moderation'+path,{method:body?'POST':'GET',headers:{...(actor?{Authorization:'Bearer '+jwt.sign({sub:actor,email:'staff@example.test',type:'access'},{expiresIn:'5m'})}:{}),'Content-Type':'application/json',...(drop?{'x-test-drop-response':'1'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};}
 function input(requestId=randomUUID()){return {requestId,submissionId:ids.sub,expectedRevision:1,decision:'approved'};}
 const route=(type:string,stage:string)=>'/'+({creative:'creatives',stack:'stacks',campaign:'campaigns'} as any)[type]+'/'+ids[type]+'/'+stage;
 beforeAll(async()=>{
  const url=new URL(process.env.PLAN0009_PG_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='25432'||url.pathname!=='/plan0009_test'||url.username!=='plan0009test')throw Error('Refusing non-disposable database');
  pool=new Pool({connectionString:url.href,max:8,connectionTimeoutMillis:5000});db=drizzle(pool,{schema});
  await pool.query('create table users(id uuid primary key,email text not null,status text not null)');
  const tables=[schema.adsCampaigns,schema.adsCreativeStacks,schema.adsCreatives,schema.adsCampaignSubmissions,schema.adsCampaignMutations,schema.adsCampaignChanges,schema.adsModerationDecisions,schema.crimfigGeoTargets];
  const dialect=new PgDialect(),quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
  const literal=(value:any):string=>value===null?'null':typeof value==='number'||typeof value==='boolean'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
  const defaults=(value:any)=>{if(value&&typeof value==='object'&&'queryChunks' in value){const q=dialect.sqlToQuery(value);return q.sql.replace(/\$(\d+)/g,(_m,index)=>literal(q.params[Number(index)-1]));}return literal(value);};
  const enums=new Set<string>();
  for(const table of tables)for(const col of getTableConfig(table).columns as any[]){if(col.enum&&!enums.has(col.enum.enumName)){enums.add(col.enum.enumName);await pool.query(`create type ${quote(col.enum.enumName)} as enum (${col.enum.enumValues.map(literal).join(',')})`);}}
  for(const table of tables){const config=getTableConfig(table);const columns=config.columns.map((col:any)=>`${quote(col.name)} ${col.getSQLType()}${col.primary?' primary key':''}${col.notNull?' not null':''}${col.isUnique?' unique':''}${col.default!==undefined?' default '+defaults(col.default):''}`);for(const unique of config.uniqueConstraints)columns.push(`constraint ${quote(unique.name!)} unique (${unique.columns.map(col=>quote(col.name)).join(',')})`);for(const fk of config.foreignKeys){const ref=fk.reference();columns.push(`foreign key (${ref.columns.map(col=>quote(col.name)).join(',')}) references ${quote(getTableName(ref.foreignTable))} (${ref.foreignColumns.map(col=>quote(col.name)).join(',')})`);}await pool.query(`create table ${quote(config.name)} (${columns.join(',')})`);for(const index of config.indexes){if(index.config.unique){const cols=index.config.columns as any[];await pool.query(`create unique index ${quote(index.config.name!)} on ${quote(config.name)} (${cols.map(col=>quote(col.name)).join(',')})`);}}}
  service=new ModerationService(db,grants);app=await NestFactory.create(LocalModule,{logger:false});app.setGlobalPrefix('api/v1');app.useGlobalInterceptors({intercept(context:any,next:any){return next.handle().pipe(tap(()=>{if(context.switchToHttp().getRequest().headers['x-test-drop-response']==='1')context.switchToHttp().getResponse().destroy();}));}});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));app.useGlobalGuards(new AdsAccessGuard(jwt,new Reflector(),db,grants));await app.listen(0,'127.0.0.1');origin=await app.getUrl();
 },30000);
 beforeEach(async()=>{
  await pool.query('truncate users,ads_campaigns cascade');roles.clear();owner=randomUUID();reviewer=randomUUID();manager=randomUUID();outsider=randomUUID();for(const id of [owner,reviewer,manager,outsider])await pool.query("insert into users values($1,$2,'ACTIVE')",[id,id+'@example.test']);roles.set(reviewer,['ads_reviewer','ads_manager']);roles.set(manager,['ads_manager']);
  const [campaign]=await db.insert(schema.adsCampaigns).values({advertiserId:owner,title:'Integration campaign',budgetUsdCents:1000,remainingBudgetUsdCents:1000,status:'under_review',moderationStatus:'pending_primary_review'}).returning();
  const [stack]=await db.insert(schema.adsCreativeStacks).values({campaignId:campaign.id,name:'Integration stack',position:0}).returning();
  const [creative]=await db.insert(schema.adsCreatives).values({campaignId:campaign.id,adStackId:stack.id,headline:'Integration ad',destinationUrl:'https://example.test',reviewStatus:'pending',status:'active'}).returning();
  const snapshot=await new CampaignWorkflow(db).snapshot(db,campaign);const [submission]=await db.insert(schema.adsCampaignSubmissions).values({campaignId:campaign.id,actorId:owner,requestId:randomUUID(),contentRevision:1,fingerprint:'a'.repeat(64),snapshot,state:'submitted',submittedAt:new Date()}).returning();await pool.query('update ads_campaigns set current_submission_id=$1,submitted_at=now() where id=$2',[submission.id,campaign.id]);ids={campaign:campaign.id,stack:stack.id,creative:creative.id,sub:submission.id};
 });
 afterAll(async()=>{await app?.close();await pool?.end();const dir=resolve('../docs/reviews/plan-0077');mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'backend-contract-fixtures.json'),JSON.stringify(artifact,null,2));});
 test('INT01/02 real guards/DTO reject unauthenticated, wrong-role and stale revision without writes',async()=>{expect((await request('/queue?stage=manager')).status).toBe(401);expect((await request('/queue',outsider)).status).toBe(403);expect((await request(route('creative','primary-review'),reviewer,{...input(),expectedRevision:0})).status).toBe(400);expect((await request(route('creative','primary-review'),reviewer,{...input(),expectedRevision:2})).status).toBe(409);expect((await pool.query('select count(*)::int n from ads_moderation_decisions')).rows[0].n).toBe(0);});
 test('INT03/04/05 all three targets progress to Manager; distinct manager completes and summary agrees',async()=>{
  for(const type of ['creative','stack','campaign']){const response=await request(route(type,'primary-review'),reviewer,input());expect(response.status).toBe(201);artifact[type+'Receipt']=response.body;}
  const response=await request('/queue?stage=manager&page=1',manager);expect(response.status).toBe(200);artifact.managerQueue=response.body;for(const key of ['creatives','stacks','campaigns'])expect(response.body.data[key]).toHaveLength(1);
  const summary=await request('/operations-summary',manager);expect(summary.body.data.managerCount).toBe(3);
  const denied=await request(route('creative','manager-approval'),reviewer,input());expect(denied.status).toBe(400);
  for(const type of ['creative','stack','campaign'])expect((await request(route(type,'manager-approval'),manager,input())).status).toBe(201);
  const complete=await request('/queue?stage=manager',manager);for(const key of ['creatives','stacks','campaigns'])expect(complete.body.data[key]).toHaveLength(0);expect((await pool.query('select count(*)::int n from ads_moderation_decisions')).rows[0].n).toBe(6);
 });
 test('INT04/10 archived and superseded submissions do not appear; out-of-range page remains honestly empty',async()=>{await pool.query("update ads_creatives set status='archived'");expect((await request('/queue?stage=reviewer',reviewer)).body.data.creatives).toHaveLength(0);await pool.query("update ads_campaign_submissions set state='withdrawn'");const empty=await request('/queue?stage=reviewer',reviewer);for(const key of ['creatives','stacks','campaigns'])expect(empty.body.data[key]).toHaveLength(0);expect((await request('/queue?stage=manager&page=2',manager)).body.data.totalPending).toBe(0);});
 test('INT06 concurrent same-request and distinct-request approvals commit only one transition',async()=>{const body=input();const same=await Promise.all([request(route('creative','primary-review'),reviewer,body),request(route('creative','primary-review'),reviewer,body)]);expect(same.map(r=>r.status)).toEqual([201,201]);expect(same[0].body.data.decision.id).toBe(same[1].body.data.decision.id);const raced=await Promise.all([request(route('stack','primary-review'),reviewer,input()),request(route('stack','primary-review'),reviewer,input())]);expect(raced.map(r=>r.status).sort()).toEqual([201,409]);expect((await pool.query('select count(*)::int n from ads_moderation_decisions')).rows[0].n).toBe(2);});
 test('INT07 real PostgreSQL trigger failure rolls back decision, target and receipts',async()=>{await pool.query("create function fail_moderation_audit() returns trigger language plpgsql as $$ begin raise exception 'injected audit failure'; end $$");await pool.query('create trigger fail_review_audit before insert on ads_campaign_changes for each row execute function fail_moderation_audit()');try{expect((await request(route('creative','primary-review'),reviewer,input())).status).toBe(500);expect((await pool.query('select review_status from ads_creatives')).rows[0].review_status).toBe('pending');for(const table of ['ads_moderation_decisions','ads_campaign_mutations'])expect((await pool.query('select count(*)::int n from '+table)).rows[0].n).toBe(0);}finally{await pool.query('drop trigger fail_review_audit on ads_campaign_changes');await pool.query('drop function fail_moderation_audit()');}});
 test('INT08 lost acknowledgement reconciles original receipt and retry has no duplicate writes',async()=>{const body=input();await expect(request(route('creative','primary-review'),reviewer,body,true)).rejects.toThrow();const receipt=await request('/campaigns/'+ids.campaign+'/review-requests/'+body.requestId,reviewer);expect(receipt.status).toBe(200);expect(receipt.body.data.result.decision.requestId).toBe(body.requestId);await request(route('creative','primary-review'),reviewer,body);expect((await pool.query('select count(*)::int n from ads_moderation_decisions')).rows[0].n).toBe(1);});
});
