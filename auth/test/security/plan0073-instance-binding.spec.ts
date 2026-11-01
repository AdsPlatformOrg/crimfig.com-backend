import { assertEventReplay, assertInstanceBinding } from '../../../api/ads-api/src/modules/delivery/interaction-binding';
import { DeliveryService, HOUSE_CAMPAIGN_UUID, HOUSE_CREATIVE_UUID, HOUSE_PLACEMENT_UUID } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { adEventJournalMatches } from '../../../shared/src/ad-evidence-journal';

describe('PLAN-0073 signed instance projection',()=>{
  const event={id:'event',eventId:'client-event',serveId:'serve',type:'impression',createdAt:new Date('2026-11-01T00:00:00Z'),slotInstanceId:'instance',instancesDetected:2};
  const payload={eventId:event.eventId,serveId:event.serveId,type:event.type,serverReceivedAt:event.createdAt.toISOString()};
  it('rejects tampered stored identities or counts against new signed observations',()=>{
    const journal={eventId:event.id,payload:{...payload,instanceClaims:{slotInstanceId:'instance',instancesDetected:2}}};
    expect(adEventJournalMatches({...event,slotInstanceId:'other'},journal)).toBe(false);
    expect(adEventJournalMatches({...event,instancesDetected:3},journal)).toBe(false);
    expect(adEventJournalMatches(event,{eventId:event.id,payload:{...payload,instanceClaims:null}})).toBe(false);
  });
  it('accepts matching new evidence and historical evidence without rewriting it',()=>{
    expect(adEventJournalMatches(event,{eventId:event.id,payload:{...payload,instanceClaims:{slotInstanceId:'instance',instancesDetected:2}}})).toBe(true);
    expect(adEventJournalMatches(event,{eventId:event.id,payload})).toBe(true);
  });
});

describe('PLAN-0073 immutable event and independent instance binding', () => {
  const identity = { pageViewId:'page-a', slotInstanceId:'instance-a', opportunityId:'opportunity-a', sdkInitId:'sdk-a' };
  const event = { ...identity, serveId:'serve-a', type:'impression', source:'embed' };

  it.each(['pageViewId','slotInstanceId','opportunityId','sdkInitId'] as const)(
    'rejects a changed %s even when the other identifiers match', key => {
      expect(() => assertInstanceBinding(identity,{...identity,[key]:'forged'})).toThrow('Serve instance identity changed');
      expect(() => assertEventReplay(event,{...event,[key]:'forged'})).toThrow();
    });
  it.each([{serveId:'other'}, {type:'click'}, {source:'direct'}])('rejects replay with changed event binding %j', change => {
    expect(() => assertEventReplay(event,{...event,...change})).toThrow('Event identity changed');
  });
  it('rejects relabeling when the first legacy event supplied only a page identity', () => {
    expect(() => assertInstanceBinding({pageViewId:'original'},identity)).toThrow();
  });
  it('accepts exact retransmission and changing descriptive count/index snapshots', () => {
    expect(() => assertEventReplay(event,{...event,instanceIndex:4,instancesDetected:5})).not.toThrow();
  });
  it('preserves legacy omissions and later compatible identity enrichment', () => {
    expect(() => assertInstanceBinding(identity,{})).not.toThrow();
    expect(() => assertInstanceBinding({},identity)).not.toThrow();
  });
  it('does not merge separate issued serves for repeated instances of the same registered slot', () => {
    const second={...event,serveId:'serve-b',slotInstanceId:'instance-b',opportunityId:'opportunity-b'};
    expect(() => assertEventReplay(event,event)).not.toThrow();
    expect(() => assertEventReplay(second,second)).not.toThrow();
  });
});

describe('PLAN-0073 ingestion transaction regressions', () => {
  const identity={pageViewId:'page-a',slotInstanceId:'instance-a',opportunityId:'opp-a',sdkInitId:'sdk-a'};
  function harness(results:any[][]) {
    const chain=(value:any)=>{const q:any={then:(resolve:any,reject:any)=>Promise.resolve(value).then(resolve,reject)};for(const key of ['from','where','limit'])q[key]=()=>q;return q;};
    const insert=jest.fn(()=>({values:(value:any)=>({returning:async()=>[value]})}));
    const execute=jest.fn(async()=>[]);
    const tx:any={select:jest.fn(()=>chain(results.shift()??[])),execute,insert};
    const db:any={select:()=>chain([{websiteId:'site',slotId:'slot',inventoryClass:'house'}]),transaction:async(fn:any)=>fn(tx)};
    const tokens:any={verifyToken:()=>({campaignId:HOUSE_CAMPAIGN_UUID,creativeId:HOUSE_CREATIVE_UUID,placementId:HOUSE_PLACEMENT_UUID,promoterId:'promoter',servedId:'serve-a'})};
    const fraud:any={validateImpression:()=>({isValid:true,assessmentStatus:'provisional',financialEligibility:'pending'}),computeKeyedIpHash:()=>({keyedIpHash:'hash',keyId:'test'})};
    const evidence:any={append:jest.fn(async()=>{})};
    const service=new DeliveryService(db,tokens,{} as any,fraud,undefined,evidence);
    (service as any).boundServe=async()=>true;
    return {service,insert,evidence,execute};
  }
  it('rejects a conflicting later-stage identity before insertion, evidence or financial effects',async()=>{
    const h=harness([[],[identity]]);
    await expect(h.service.logInteraction({impToken:'signed',type:'impression',claims:{...identity,opportunityId:'other'}})).rejects.toThrow('Serve instance identity changed');
    expect(h.insert).not.toHaveBeenCalled();expect(h.evidence.append).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalled();
  });
  it('rejects conflicting identity on a reused event ID without writing',async()=>{
    const h=harness([[{...identity,serveId:'serve-a',type:'impression',source:'embed'}]]);
    await expect(h.service.logInteraction({impToken:'signed',type:'impression',claims:{...identity,pageViewId:'other'}})).rejects.toThrow();
    expect(h.insert).not.toHaveBeenCalled();expect(h.evidence.append).not.toHaveBeenCalled();
  });
  it('deduplicates legacy impression retransmission by serve stage even without eventId',async()=>{
    const stage={...identity,id:'prior',serveId:'serve-a',type:'impression',financialEligibility:'invalid'};
    const h=harness([[],[identity],[stage]]);
    expect(await h.service.logInteraction({impToken:'signed',type:'impression',claims:identity})).toBe(stage);
    expect(h.insert).not.toHaveBeenCalled();expect(h.evidence.append).not.toHaveBeenCalled();
  });
  it('persists independent claims in signed evidence and leaves House non-payable',async()=>{
    const h=harness([[],[],[]]);
    const event=await h.service.logInteraction({impToken:'signed',type:'impression',claims:identity});
    expect(event).toMatchObject({...identity,financialEligibility:'invalid',isValid:false});
    expect(h.evidence.append.mock.calls[0][1].instanceClaims).toMatchObject(identity);
    expect(h.insert).toHaveBeenCalledTimes(1);
  });
});
