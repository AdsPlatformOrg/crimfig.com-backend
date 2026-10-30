import { BadRequestException, ConflictException } from '@nestjs/common';
import { CampaignWorkflow, campaignCapabilities, currentApproval, assertEditableCampaign, fingerprint, controlRequired } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
const id='11111111-1111-4111-8111-111111111111', owner='22222222-2222-4222-8222-222222222222', requestId='33333333-3333-4333-8333-333333333333';
const submissionId='44444444-4444-4444-8444-444444444444', reviewerA='55555555-5555-4555-8555-555555555555', reviewerB='66666666-6666-4666-8666-666666666666';
const draft=()=>({id,advertiserId:owner,contentRevision:1,status:'draft',moderationStatus:'draft',currentSubmissionId:null,approvedRevision:null,approvedSubmissionId:null,submissionIntentId:null,title:'Original'});
function harness(c=draft(),prior:any=null) {
  const writes:any[]=[];
  const chain=(rows:any[])=>{const q:any={}; for(const key of ['from','where','for','limit'])q[key]=jest.fn(()=>q);q.then=(r:any)=>Promise.resolve(rows).then(r);return q;};
  let reads=0;
  const tx:any={execute:jest.fn(),select:jest.fn(()=>chain(reads++===0?[c]:reads===2?(prior?[prior]:[]):[c])),
    update:jest.fn(()=>({set:(patch:any)=>({where:()=>{Object.assign(c,patch);return Promise.resolve();}})})),
    insert:jest.fn((table:any)=>({values:jest.fn((row:any)=>{writes.push(row);return Promise.resolve();})}))};
  const db={transaction:jest.fn(async(fn:any)=>fn(tx))};const workflow=new CampaignWorkflow(db);
  jest.spyOn(workflow,'snapshot').mockImplementation(async(_tx,c)=>({campaign:{...c},stacks:[],creatives:[],targets:[]}));
  return {workflow,tx,db,c,writes};
}
describe('PLAN-0048 revision and audit foundation',()=>{
  it('stable canonical hashes ignore key insertion order but detect actual changes',()=>{
    expect(fingerprint({b:2,a:1})).toBe(fingerprint({a:1,b:2}));expect(fingerprint({a:1})).not.toBe(fingerprint({a:2}));
  });
  it('requires a valid immutable request identity and positive expected revision',()=>{
    for(const c of [undefined,{requestId:'bad',expectedRevision:1},{requestId,expectedRevision:0}])expect(()=>controlRequired(c)).toThrow(BadRequestException);
  });
  it.each(['suspended','trash','completed','cancelled'])('blocks all owner editing in %s state',status=>{
    const c={...draft(),status};expect(()=>assertEditableCampaign(c)).toThrow(ConflictException);expect(campaignCapabilities(c).canBeginEdit).toBe(false);
  });
  it('drafts can edit/submit but cannot activate; submitted campaigns require explicit withdrawal',()=>{
    expect(campaignCapabilities(draft())).toMatchObject({canEdit:true,canSubmit:true,canActivate:false});
    expect(()=>assertEditableCampaign({...draft(),moderationStatus:'pending_primary_review',currentSubmissionId:id})).toThrow(ConflictException);
    expect(campaignCapabilities({...draft(),moderationStatus:'pending_manager_approval',currentSubmissionId:id}).canBeginEdit).toBe(true);
  });
  it('legacy, changed and in-flight approvals cannot authorize activation',()=>{
    const c={...draft(),status:'paused',moderationStatus:'approved',currentSubmissionId:id,approvedSubmissionId:id,approvedRevision:1};
    expect(currentApproval(c)).toBe(true);
    for(const patch of [{currentSubmissionId:null},{approvedRevision:0},{contentRevision:2},{submissionIntentId:requestId},{approvedSubmissionId:requestId}])expect(currentApproval({...c,...patch})).toBe(false);
  });
  it('stale editor fails before content/audit writes',async()=>{
    const h=harness();const work=jest.fn();await expect(h.workflow.mutate(id,owner,'save',{expectedRevision:2,requestId},{title:'New'},work)).rejects.toThrow(ConflictException);
    expect(work).not.toHaveBeenCalled();expect(h.writes).toHaveLength(0);expect(h.tx.execute).toHaveBeenCalledTimes(2);
  });
  it('actual edits increment once and audit in the same transaction; no-op saves do not',async()=>{
    const h=harness();const result=await h.workflow.mutate(id,owner,'save',{expectedRevision:1,requestId},{title:'New'},async()=>{h.c.title='New';return h.c;});
    expect(result.contentRevision).toBe(2);expect(h.writes).toHaveLength(2);expect(h.writes[0]).toMatchObject({priorRevision:1,contentRevision:2,actorId:owner,changedFields:['title']});
    const no=harness();await no.workflow.mutate(id,owner,'save',{expectedRevision:1,requestId},{title:'Original'},async()=>no.c);
    expect(no.c.contentRevision).toBe(1);expect(no.writes).toHaveLength(1);expect(no.writes[0].action).toBe('save');
  });
  it('replays an identical operation before stale-version check; mismatched payload conflicts',async()=>{
    const control={expectedRevision:1,requestId},payload={title:'New'},hash=fingerprint({action:'save',payload,expectedRevision:1});
    const h=harness({...draft(),contentRevision:2},{fingerprint:hash,result:{id,contentRevision:2}});const work=jest.fn();
    await expect(h.workflow.mutate(id,owner,'save',control,payload,work)).resolves.toEqual({id,contentRevision:2});expect(work).not.toHaveBeenCalled();
    const other=harness(draft(),{fingerprint:hash});await expect(other.workflow.mutate(id,owner,'save',control,{title:'Other'},work)).rejects.toThrow(ConflictException);
  });
  it('audit failure rejects the enclosing transaction and never saves a success receipt',async()=>{
    const h=harness();jest.spyOn(h.workflow,'audit').mockRejectedValue(new Error('audit unavailable'));
    await expect(h.workflow.mutate(id,owner,'save',{expectedRevision:1,requestId},{title:'New'},async()=>{h.c.title='New';return h.c;})).rejects.toThrow('audit unavailable');
    expect(h.db.transaction).toHaveBeenCalledTimes(1);expect(h.writes).toHaveLength(0);
  });
  it('moderation decide rejects self-review, stale submission/revision, unapproved creatives and same-reviewer manager approval',async()=>{
    const camp={...draft(),status:'paused',moderationStatus:'pending_primary_review',currentSubmissionId:submissionId,contentRevision:2};
    const sub={id:submissionId,state:'submitted',contentRevision:2};
    const makeModeration=(c:any,submission:any=sub,creatives:any[]=[{id:'c1',reviewStatus:'approved'}])=>{
      const writes:any[]=[];
      let call=0;
      const chain=(rows:any[])=>{const q:any={};for(const k of ['from','where','for','limit','orderBy'])q[k]=jest.fn(()=>q);q.then=(r:any)=>Promise.resolve(rows).then(r);return q;};
      const tx:any={execute:jest.fn(),select:jest.fn(()=>{call++;if(call===1)return chain([c]);if(call===2)return chain([]);if(call===3)return chain(submission?[submission]:[]);return chain(creatives);}),
        update:jest.fn(()=>({set:(patch:any)=>({where:()=>({returning:async()=>[{...Object.assign(c,patch)}]})})})),
        insert:jest.fn(()=>({values:(row:any)=>{writes.push(row);return {returning:async()=>[row],then:(r:any)=>Promise.resolve([row]).then(r)};}}))};
      const service=new ModerationService({transaction:async(fn:any)=>fn(tx)} as any);
      jest.spyOn((service as any).workflow,'snapshot').mockImplementation(async(_tx:any,row:any)=>({campaign:{...row},stacks:[],creatives:[],targets:[]}));
      return {service,writes,c};
    };
    await expect(makeModeration({...camp}).service.reviewCampaignPrimary(id,{reviewerId:owner,decision:'approved',expectedRevision:2,submissionId,requestId})).rejects.toThrow(BadRequestException);
    await expect(makeModeration({...camp}).service.reviewCampaignPrimary(id,{reviewerId:reviewerA,decision:'approved',expectedRevision:1,submissionId,requestId})).rejects.toThrow(ConflictException);
    await expect(makeModeration({...camp},{...sub,state:'superseded'}).service.reviewCampaignPrimary(id,{reviewerId:reviewerA,decision:'approved',expectedRevision:2,submissionId,requestId})).rejects.toThrow(ConflictException);
    await expect(makeModeration({...camp},sub,[{id:'c1',reviewStatus:'pending'}]).service.reviewCampaignPrimary(id,{reviewerId:reviewerA,decision:'approved',expectedRevision:2,submissionId,requestId})).rejects.toThrow(ConflictException);

    const primary=makeModeration({...camp});
    const r1:any=await primary.service.reviewCampaignPrimary(id,{reviewerId:reviewerA,decision:'approved',expectedRevision:2,submissionId,requestId});
    expect(r1.nextStage).toBe('pending_manager_approval');
    expect(primary.c.primaryReviewerId).toBe(reviewerA);

    await expect(makeModeration({...primary.c}).service.reviewCampaignManager(id,{reviewerId:reviewerA,decision:'approved',expectedRevision:2,submissionId,requestId})).rejects.toThrow(BadRequestException);
    const manager=makeModeration({...primary.c});
    const r2:any=await manager.service.reviewCampaignManager(id,{reviewerId:reviewerB,decision:'approved',expectedRevision:2,submissionId,requestId});
    expect(r2.nextStage).toBe('approved');
    expect(manager.c.approvedSubmissionId).toBe(submissionId);
    expect(manager.c.approvedRevision).toBe(2);
    expect(currentApproval(manager.c)).toBe(true);
  });
});
