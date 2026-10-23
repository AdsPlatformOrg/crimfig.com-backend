import { RefundReviewService } from '../../../api/billing-api/src/modules/withdrawals/refund-review.service';
const operator='11111111-1111-4111-8111-111111111111';
describe('finance operator authority',()=>{
 test.each(['{}','null','["admin"]','[1]'])('rejects malformed grants %s', grants=>{
  expect(()=>new RefundReviewService({} as any,{} as any,{get:()=>grants} as any)).toThrow();
 });
 test('empty configured grants deny all workflow operations before DB or provider access',async()=>{
  const forbidden=new Proxy({},{get(){throw Error('Unexpected access');}});
  const service=new RefundReviewService(forbidden as any,forbidden as any,{get:()=>undefined} as any);
  await expect(service.prepare(operator,'ref',{providerEvidenceId:'x',retainedFeeKobo:0,retainedStampDutyKobo:0})).rejects.toThrow('Finance operator access');
  await expect(service.read(operator,'ref')).rejects.toThrow('Finance operator access');
  await expect(service.approve(operator,'ref','draft')).rejects.toThrow('Finance operator access');
 });
 test('a configured but suspended operator cannot reach provider verification',async()=>{
  const query:any={from:()=>query,where:()=>query,for:async()=>[{status:'SUSPENDED'}]};
  const provider:any={verifyTransfer:jest.fn()};
  const service=new RefundReviewService({select:()=>query} as any,provider,{get:()=>JSON.stringify([operator])} as any);
  await expect(service.prepare(operator,'wd_'+'a'.repeat(40),{providerEvidenceId:'x',retainedFeeKobo:0,retainedStampDutyKobo:0})).rejects.toThrow('Active finance');
  expect(provider.verifyTransfer).not.toHaveBeenCalled();
 });
});
