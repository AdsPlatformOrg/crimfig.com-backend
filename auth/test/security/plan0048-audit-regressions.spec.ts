import {ConflictException} from '@nestjs/common';
import {CampaignWorkflow,currentApproval,fingerprint} from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import {ModerationService} from '../../../api/ads-api/src/modules/moderation/moderation.service';
import {CampaignEscrowService} from '../../../api/billing-api/src/modules/ecosystem/campaign-escrow.service';
const campaignId='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',reviewer='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444',submissionId='55555555-5555-4555-8555-555555555555';
const current=()=>({id:campaignId,advertiserId:owner,status:'paused',moderationStatus:'approved',contentRevision:2,approvedRevision:2,currentSubmissionId:submissionId,approvedSubmissionId:submissionId,submissionIntentId:null});
const params={decision:'approved' as const,reviewerId:reviewer,requestId,submissionId,expectedRevision:2};
describe('PLAN-0048 stale receipt and funding guards — failures first',()=>{
  afterEach(()=>jest.restoreAllMocks());
  it.each([undefined,null,0,-1,1.5,NaN])('does not authorize an approval with malformed content revision %s',revision=>{
    expect(currentApproval({...current(),contentRevision:revision,approvedRevision:revision})).toBe(false);
  });
  it.each([{currentSubmissionId:requestId},{contentRevision:3},{status:'draft'},{submissionIntentId:requestId}])('rejects an old decision replay after a submission change: %j',async patch=>{
    jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue({...current(),...patch});
    const tx:any={select:jest.fn(),insert:jest.fn(),update:jest.fn()};const db:any={transaction:(fn:any)=>fn(tx)};
    const service=new ModerationService(db);
    await expect(service.reviewCampaignPrimary(campaignId,params)).rejects.toThrow(ConflictException);
    expect(tx.select).not.toHaveBeenCalled();expect(tx.insert).not.toHaveBeenCalled();expect(tx.update).not.toHaveBeenCalled();
  });
  it.each(['paused','trash'] as const)('cannot %s or release funding while submission confirmation is pending',async target=>{
    const c={...current(),submissionIntentId:requestId};const q:any={from:()=>q,where:()=>q,for:async()=>[c]};
    const tx:any={execute:jest.fn(),select:()=>q,insert:jest.fn(),update:jest.fn()};const db:any={transaction:(fn:any)=>fn(tx)};
    await expect(new CampaignEscrowService(db).change(owner,campaignId,'release',undefined,target)).rejects.toThrow(ConflictException);
    expect(tx.insert).not.toHaveBeenCalled();expect(tx.update).not.toHaveBeenCalled();
  });
  it('allows a matching decision replay for the same current submission without repeating its mutation',async()=>{
    const c=current();jest.spyOn(CampaignWorkflow.prototype,'lock').mockResolvedValue(c);
    const saved={campaign:c,decision:{id:'original'},live:false};const hash=fingerprint({stage:'primary',creativeId:null,...params});
    const q:any={from:()=>q,where:()=>q,limit:async()=>[{fingerprint:hash,result:saved}]};const tx:any={select:()=>q,insert:jest.fn(),update:jest.fn()};
    const service=new ModerationService({transaction:(fn:any)=>fn(tx)} as any);
    await expect(service.reviewCampaignPrimary(campaignId,params)).resolves.toEqual(saved);expect(tx.insert).not.toHaveBeenCalled();expect(tx.update).not.toHaveBeenCalled();
    expect(currentApproval(c)).toBe(true);
  });
});
