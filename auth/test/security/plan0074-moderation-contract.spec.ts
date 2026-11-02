import 'reflect-metadata';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { ModerationController } from '../../../api/ads-api/src/modules/moderation/moderation.controller';
import { ADS_ROLES_KEY, AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
import { CampaignWorkflow } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import { adsCampaigns, adsCampaignSubmissions, adsCreatives, adsCreativeStacks, adsCampaignMutations, adsModerationDecisions } from '@crimfig/database/schema';
const id='11111111-1111-4111-8111-111111111111', actor='22222222-2222-4222-8222-222222222222', owner='33333333-3333-4333-8333-333333333333', sub='44444444-4444-4444-8444-444444444444', requestId='55555555-5555-4555-8555-555555555555';
const roleCases=[[],['ads_support'],['ads_finance'],['ads_reviewer'],['ads_manager'],['ads_admin'],['super_admin'],['ads_reviewer','ads_manager']];
function fixture(roles:string[], options:{stale?:boolean;own?:boolean;state?:string;primary?:string;missing?:boolean}={}) {
 const campaign={id,advertiserId:options.own?actor:owner,currentSubmissionId:sub,contentRevision:3,status:'paused',moderationStatus:options.state||'pending_primary_review',primaryReviewerId:options.primary};
 const child={id,campaignId:id,status:'active',archived:false,reviewStatus:options.state||'pending',primaryReviewerId:options.primary};
 const content={id,campaignId:id,headline:'Immutable headline',adType:'image',adStackId:id};
 const rows=new Map<any,any[]>([[adsCampaigns,[campaign]],[adsCreatives,[child]],[adsCreativeStacks,[child]],[adsCampaignSubmissions,options.missing?[]:[{id:sub,state:'submitted',contentRevision:options.stale?2:3,snapshot:{campaign,creatives:[content],stacks:[content],targets:[]}}]],[adsModerationDecisions,[]]]);
 const queries:any[]=[];
 const db:any={execute:jest.fn(),transaction:async(fn:any)=>fn(db),select:jest.fn(()=>{let table:any;const chain:any={from:(t:any)=>{table=t;return chain;},where:()=>chain,orderBy:()=>chain,limit:(n:number)=>{queries.push({table,n});return chain;},offset:()=>chain,then:(resolve:any)=>resolve(rows.get(table)||[])};return chain;})};
 const grants={rolesFor:()=>roles} as unknown as AdsStaffGrants;
 return {service:new ModerationService(db,grants),db,rows,campaign,queries};
}
afterEach(()=>jest.restoreAllMocks());
describe('PLAN0074 rejection-first moderation contracts',()=>{
 test.each(['bad','website'])('rejects invalid details target %s before database access',async(type)=>{const f=fixture([]);await expect(f.service.itemDetail(type,id,actor)).rejects.toThrow();expect(f.db.select).not.toHaveBeenCalled();});
 test.each([0,-1,1.5,NaN,4001])('rejects unbounded queue page %s',async(page)=>{const f=fixture([]);await expect(f.service.getQueue('reviewer',page)).rejects.toThrow('Invalid queue page');});
 test.each(['creative','stack','campaign'])('missing or stale submission blocks both decisions but preserves %s inspection',async type=>{for(const option of [{stale:true},{missing:true}]){const f=fixture(['ads_admin'],option);const result=await f.service.itemDetail(type,id,actor);expect(result.submissionId).toBeNull();expect(result.capabilities.reviewer.allowed).toBe(false);expect(result.capabilities.manager.allowed).toBe(false);}});
 test.each(['creative','stack','campaign'])('owner cannot review own %s, including super admin',async type=>{const f=fixture(['super_admin'],{own:true});expect((await f.service.itemDetail(type,id,actor)).capabilities.reviewer.reason).toMatch(/Owners cannot/);});
 for(const roles of roleCases)for(const type of ['creative','stack','campaign'])for(const stage of ['reviewer','manager'] as const){
  test(`${roles.join()||'none'} ${type} ${stage}: controller and authoritative capability agree`,async()=>{
   const primary=stage==='reviewer';const f=fixture(roles,{state:primary?(type==='campaign'?'pending_primary_review':'pending'):'pending_manager_approval'});
   const result=await f.service.itemDetail(type,id,actor);
   const action=primary?'primaryReview':'managerApproval';const suffix=type[0].toUpperCase()+type.slice(1);
   const required=Reflect.getMetadata(ADS_ROLES_KEY,(ModerationController.prototype as any)[action+suffix]);
   const expected=roles.some(role=>required.includes(role));expect(result.capabilities[stage].allowed).toBe(expected);
  });
 }
 test.each([['ads_reviewer','ads_manager'],['ads_admin'],['super_admin']])('same actor Review2 respects existing admin exception %j',async(...roles)=>{
  const f=fixture(roles,{state:'pending_manager_approval',primary:actor});const d=await f.service.itemDetail('creative',id,actor);expect(d.capabilities.manager.allowed).toBe(roles.includes('ads_admin')||roles.includes('super_admin'));
 });
 test('readonly details executes bounded timeout and preserves immutable content separately',async()=>{const f=fixture(['ads_support']);const d=await f.service.itemDetail('creative',id,actor);expect(d.content?.headline).toBe('Immutable headline');expect(d.item).not.toHaveProperty('headline');expect(f.db.execute).toHaveBeenCalledTimes(2);expect(f.queries.some(q=>q.n===26)).toBe(true);});
 test('receipt refuses missing and non-review mutation records',async()=>{for(const rows of [[],[{action:'save'}]]){const f=fixture(['ads_support']);f.rows.set(adsCampaignMutations,rows);await expect(f.service.reviewReceipt(id,requestId,actor)).rejects.toThrow('Review receipt not found');}});
 test('archived receipt cannot authorize a blind retry',async()=>{const f=fixture(['ads_reviewer']);f.rows.set(adsCampaignMutations,[{action:'review_campaign_primary',purgedAt:new Date()}]);await expect(f.service.reviewReceipt(id,requestId,actor)).rejects.toThrow(/archived/);});
 test('immutable own review receipt is returned for reconciliation',async()=>{const f=fixture(['ads_reviewer']);f.rows.set(adsCampaignMutations,[{action:'review_campaign_primary',result:{targetId:id}}]);expect(await f.service.reviewReceipt(id,requestId,actor)).toEqual({requestId,result:{targetId:id}});});
 test('service rejects a support-only mutation before locking/writing',async()=>{const f=fixture(['ads_support']);await expect(f.service.reviewCampaignPrimary(id,{submissionId:sub,expectedRevision:3,requestId,reviewerId:actor,decision:'approved'})).rejects.toThrow(/staff role/);expect(f.db.execute).not.toHaveBeenCalled();});
 test('exact same-intent replay returns prior immutable outcome even after campaign revision changes',async()=>{
  const f=fixture(['ads_reviewer']);const params={submissionId:sub,expectedRevision:3,requestId,reviewerId:actor,decision:'approved' as const};
  const {fingerprint}=require('../../../api/ads-api/src/modules/campaigns/campaign-workflow');
  f.rows.set(adsCampaignMutations,[{fingerprint:fingerprint({stage:'primary',targetType:'campaign',targetId:id,...params}),result:{receipt:'original'}}]);
  jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue({...f.campaign,contentRevision:4});
  expect(await f.service.reviewCampaignPrimary(id,params)).toEqual({receipt:'original'});
  await expect(f.service.reviewCampaignPrimary(id,{...params,decision:'rejected',reasonCode:'POLICY_VIOLATION'})).rejects.toThrow(/request changed/);
 });
 test('cross-campaign submitted content cannot enable review',async()=>{
  const f=fixture(['ads_admin']);const submission=f.rows.get(adsCampaignSubmissions)![0];submission.snapshot.creatives[0].campaignId=owner;
  const result=await f.service.itemDetail('creative',id,actor);expect(result.content).toBeNull();expect(result.capabilities.reviewer.allowed).toBe(false);
 });
 test('begin edit clears all child reviewer stamps and stack state inside the existing workflow',async()=>{
  const writes:{table:any,value:any}[]=[];const db:any={update:(table:any)=>({set:(value:any)=>{writes.push({table,value});return {where:()=>({returning:async()=>[{id,status:'draft'}]})};}})};
  jest.spyOn(CampaignWorkflow.prototype,'mutate').mockImplementation(async(_id,_owner,_action,_control,_payload,work)=>work(db,{id,currentSubmissionId:sub,status:'paused'}));
  const service=new CampaignsService(db,{} as any,{} as any);await service.beginEdit(id,owner,{expectedRevision:3,requestId,submissionId:sub});
  for(const table of [adsCreatives,adsCreativeStacks]){
   const update=writes.find(row=>row.table===table)!.value;
   expect(update).toMatchObject({reviewStatus:'pending',primaryReviewerId:null,managerReviewerId:null,primaryReviewedAt:null,managerReviewedAt:null,rejectionReason:null});
  }
  expect(writes.find(row=>row.table===adsCampaignSubmissions)!.value.state).toBe('superseded');
 });
 for(const hasEligibleChild of [false,true])test(`campaign stage prerequisite uses current eligible children: ${hasEligibleChild}`,async()=>{
  const f=fixture(['ads_reviewer']);f.rows.set(adsCreatives,hasEligibleChild?[{status:'active',reviewStatus:'approved'}]:[]);
  jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue(f.campaign);
  jest.spyOn(CampaignWorkflow.prototype,'snapshot').mockResolvedValue({campaign:f.campaign,stacks:[],creatives:[]} as any);
  jest.spyOn(CampaignWorkflow.prototype,'audit').mockResolvedValue(undefined);
  f.db.update=()=>({set:()=>({where:()=>({returning:async()=>[{...f.campaign,moderationStatus:'pending_manager_approval'}]})})});
  f.db.insert=()=>({values:()=>({returning:async()=>[{id:requestId,decision:'approved'}]})});
  const action=f.service.reviewCampaignPrimary(id,{submissionId:sub,expectedRevision:3,requestId,reviewerId:actor,decision:'approved'});
  if(hasEligibleChild)expect(await action).toMatchObject({campaign:{moderationStatus:'pending_manager_approval'}});else await expect(action).rejects.toThrow(/zero approved Ads/);
 });
 test('audit failure rejects the transaction callback before any success receipt is inserted (not a real DB rollback proof)',async()=>{
  const f=fixture(['ads_reviewer']);f.rows.set(adsCreatives,[{reviewStatus:'approved'}]);
  jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue(f.campaign);
  jest.spyOn(CampaignWorkflow.prototype,'snapshot').mockResolvedValue({campaign:f.campaign,stacks:[],creatives:[]} as any);
  jest.spyOn(CampaignWorkflow.prototype,'audit').mockRejectedValue(Error('audit unavailable'));
  const tables:any[]=[];f.db.update=()=>({set:()=>({where:()=>({returning:async()=>[f.campaign]})})});
  f.db.insert=(table:any)=>{tables.push(table);return {values:()=>({returning:async()=>[{id:requestId,decision:'approved'}]})};};
  await expect(f.service.reviewCampaignPrimary(id,{submissionId:sub,expectedRevision:3,requestId,reviewerId:actor,decision:'approved'})).rejects.toThrow('audit unavailable');expect(tables).not.toContain(adsCampaignMutations);
 });

});
