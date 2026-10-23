import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';

describe('Signed withdrawal callback integration', () => {
  function fixture() {
    const updates: any[]=[];
    const db:any={insert:()=>({values:()=>({onConflictDoNothing:async()=>undefined})}),update:()=>({set:(value:any)=>{updates.push(value);return {where:async()=>undefined};}})};
    const ledger:any={complete:jest.fn(async()=>({status:'completed'}))};
    const service=new WebhooksService(db,{verifyWebhookSignature:()=>true} as any,{} as any,ledger);
    return {service,ledger,updates};
  }
  const event=(status:string)=>JSON.stringify({event:'transfer.'+status,data:{reference:'wd_1234567890123456789012345678901234567890',status}});
  it.each(['success','failed','reversed'])('converges signed %s evidence on the atomic withdrawal ledger',async status=>{
    const {service,ledger,updates}=fixture();
    await expect(service.handlePaystackWebhook(event(status),'fixture')).resolves.toEqual({status:'success'});
    expect(ledger.complete).toHaveBeenCalledTimes(1);expect(ledger.complete.mock.calls[0][1].status).toBe(status);
    expect(updates.at(-1).processed).toBe(true);
  });
  it('does not acknowledge a rejected/unreconciled withdrawal outcome',async()=>{
    const {service,ledger,updates}=fixture();ledger.complete.mockRejectedValue(Error('mismatch'));
    await expect(service.handlePaystackWebhook(event('success'),'fixture')).rejects.toMatchObject({status:503});
    expect(updates.some(value=>value.processed===true)).toBe(false);
  });
  it('rejects contradictory signed event type/data before invoking the ledger',async()=>{
    const {service,ledger}=fixture();
    const body=JSON.parse(event('success'));body.data.status='failed';
    await expect(service.handlePaystackWebhook(JSON.stringify(body),'fixture')).rejects.toMatchObject({status:400});
    expect(ledger.complete).not.toHaveBeenCalled();
  });
});
