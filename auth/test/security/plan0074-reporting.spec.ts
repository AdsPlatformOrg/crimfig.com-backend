import { elapsedSeconds, pendingModerationWork, queueMembership, queueClock } from '../../../api/ads-api/src/modules/moderation/moderation-reporting';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { CampaignWorkflow, fingerprint } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import { reviewOptions } from '../../../api/ads-api/src/modules/moderation/review-policy';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const asOf='2026-11-02T12:00:00.000Z';
const id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',sub='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const grants={rolesFor:()=>['ads_reviewer']} as unknown as AdsStaffGrants;
afterEach(()=>jest.restoreAllMocks());
describe('PLAN0074 reporting and reason compatibility, rejection first',()=>{
 test.each([null,undefined,'bad','2026-11-02 11:00:00','2026-11-02T12:00:01Z'])('unavailable/future/ambiguous age %s is never zero',time=>expect(elapsedSeconds(time,asOf)).toBeNull());
 test('a stage clock before its new submission is unavailable rather than inherited',()=>expect(elapsedSeconds('2026-11-01T10:00:00Z',asOf,'2026-11-02T10:00:00Z')).toBeNull());
 test('invalid summary filter is rejected before any database access',async()=>{const execute=jest.fn();const svc=new ModerationService({execute} as any,grants);await expect(svc.operationsSummary('finance')).rejects.toThrow('Unsupported');expect(execute).not.toHaveBeenCalled();});
 test.each([{rows:[]},{rows:[{}]},{rows:[{reviewerCount:-1,managerCount:0,submissionCount:0,unknownAgeCount:0}]}])('missing/invalid aggregate is not reported as an empty queue',async ({rows})=>{const svc=new ModerationService({execute:async()=>({rows})} as any,grants);await expect(svc.operationsSummary()).rejects.toThrow(/unavailable/);});
 test('read failure does not return invented totals or overdue zero',async()=>{const svc=new ModerationService({execute:async()=>{throw Error('offline');}} as any,grants);await expect(svc.operationsSummary()).rejects.toThrow('offline');});
 test('whitespace-only explanations and internal-only notes cannot justify rejection',async()=>{const svc=new ModerationService({} as any,grants);for(const input of [{advertiserNote:'   '},{internalNote:'staff only'}])await expect(svc.reviewCampaignPrimary(id,{submissionId:sub,requestId,expectedRevision:1,reviewerId:actor,decision:'rejected',...input})).rejects.toThrow(/reason or note/);});
 test('new unsupported reason codes fail before transition or audit writes',async()=>{
  jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue({id,currentSubmissionId:sub,contentRevision:1,status:'paused'});
  const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[]})})}),update:jest.fn(),insert:jest.fn()};
  const svc=new ModerationService({transaction:async(fn:any)=>fn(tx)} as any,grants);
  await expect(svc.reviewCampaignPrimary(id,{submissionId:sub,requestId,expectedRevision:1,reviewerId:actor,decision:'rejected',reasonCode:'UNKNOWN_NEW_CODE'})).rejects.toThrow(/Unsupported rejection/);expect(tx.update).not.toHaveBeenCalled();expect(tx.insert).not.toHaveBeenCalled();
 });
 test('legacy reason replay returns its original receipt before new taxonomy validation',async()=>{
  const params={submissionId:sub,requestId,expectedRevision:1,reviewerId:actor,decision:'rejected' as const,reasonCode:'HISTORICAL_CODE'};
  jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue({id,contentRevision:2,status:'draft'});
  const receipt={fingerprint:fingerprint({stage:'primary',targetType:'campaign',targetId:id,...params}),result:{legacy:true}};
  const tx={select:()=>({from:()=>({where:()=>({limit:async()=>[receipt]})})})};const svc=new ModerationService({transaction:async(fn:any)=>fn(tx)} as any,grants);expect(await svc.reviewCampaignPrimary(id,params)).toEqual({legacy:true});
 });
 test('known exact boundary and offset timestamps use UTC elapsed time',()=>{expect(elapsedSeconds(asOf,asOf)).toBe(0);expect(elapsedSeconds('2026-11-02T12:00:00+01:00',asOf)).toBe(3600);expect(elapsedSeconds(new Date('2026-11-02T00:00:00Z'),new Date(asOf))).toBe(43200);});
 test('aggregate totals are independent of loaded pages, real zeros retained, SLA unavailable',async()=>{
  for(const count of [0,151]){const svc=new ModerationService({execute:async()=>({rows:[{asOf,reviewerCount:count,managerCount:20,submissionCount:30,oldestSubmittedAt:'2026-11-01T12:00:00Z',unknownAgeCount:2}]})} as any,grants);expect(await svc.operationsSummary('creative')).toMatchObject({scope:'creative',reviewerCount:count,managerCount:20,oldestAgeSeconds:86400,overdueCount:null,targetStatus:'not_configured'});}
 });
 test('canonical options preserve the seven stable codes and separate custom explanation path',()=>{expect(reviewOptions().reasons.map(r=>r.code)).toEqual(['POLICY_VIOLATION','MISLEADING','PROHIBITED','BROKEN_URL','LOW_QUALITY','TRADEMARK','BUDGET_OR_TARGETING_ISSUE']);expect(reviewOptions()).toMatchObject({noteMaxLength:2000,customExplanationAllowed:true});});
 test('shared SQL builders parameterize scope and immutable evidence bindings (no DB execution proof)',()=>{
  const dialect=new PgDialect();const work=dialect.sqlToQuery(pendingModerationWork());expect(work.sql).toContain('s.content_revision = c.content_revision');expect(work.sql).toContain('d.submission_id = w.submission_id');expect(work.sql).toContain('d.content_revision = w.content_revision');expect(work.sql).not.toContain('primary_reviewed_at');
  const membership=dialect.sqlToQuery(queueMembership('creative',sql`id`,'manager'));const clock=dialect.sqlToQuery(queueClock('creative',sql`id`,'manager'));expect(membership.params).toContain('creative');expect(clock.params).toContain('manager');expect(membership.sql).toContain(work.sql);expect(clock.sql).toContain(work.sql);
 });
 test('empty queue remains genuinely empty and every type uses the same immutable work relation',async()=>{
  const filters:any[]=[];const tx:any={execute:jest.fn(),select:()=>{const chain:any={from:()=>chain,innerJoin:()=>chain,where:(filter:any)=>{filters.push(filter);return chain;},orderBy:()=>chain,limit:()=>chain,offset:()=>chain,then:(resolve:any)=>resolve([])};return chain;}};
  const svc=new ModerationService({transaction:async(fn:any)=>fn(tx)} as any,grants);expect(await svc.getQueue('manager',2)).toMatchObject({campaigns:[],stacks:[],creatives:[],page:2,totalPending:0,countScope:'loaded_page',hasMore:{campaigns:false,stacks:false,creatives:false}});
  expect(tx.execute).toHaveBeenCalledTimes(2);expect(filters).toHaveLength(3);const dialect=new PgDialect();for(const filter of filters){const query=dialect.sqlToQuery(filter);expect(query.sql).toContain(dialect.sqlToQuery(pendingModerationWork()).sql);expect(query.params).toContain('manager');}
 });

});
