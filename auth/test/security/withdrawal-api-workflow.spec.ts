import { WithdrawalLedgerService } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-ledger.service';
import { WithdrawalsService } from '../../../api/billing-api/src/modules/withdrawals/withdrawals.service';
import { WithdrawalsController } from '../../../api/billing-api/src/modules/withdrawals/withdrawals.controller';

function fixture(duplicate=false) {
  const ledger:any={reserve:jest.fn(async()=>({withdrawalId:'id',reference:'reference',status:'pending',alreadyReserved:duplicate})),dispatchIntent:jest.fn(async()=>({status:'processing'})),cancel:jest.fn(async()=>({status:'cancelled'}))};
  const dispatch:any={dispatch:jest.fn(async()=>({status:'processing',confirmation:'unconfirmed'})),recover:jest.fn(async()=>({status:'completed',confirmation:'confirmed'}))};
  const unused=new Proxy({},{get(){throw Error('Unexpected legacy/provider/FX effect');}});
  return {ledger,dispatch,service:new WithdrawalsService(unused as any,unused as any,unused as any,unused as any,ledger,dispatch)};
}
const input={userId:'owner',requestId:'request',bankAccountId:'bank',amountUsd:5.01,quoteId:'quote'};
it('withdrawal create reserves canonical cents and sends through one dispatch authority',async()=>{
  const {service,ledger,dispatch}=fixture();
  const result=await service.requestWithdrawal(input);
  expect(ledger.reserve).toHaveBeenCalledWith('owner','request','bank',501,'quote');
  expect(dispatch.dispatch).toHaveBeenCalledWith('owner','reference');expect(result.confirmation).toBe('unconfirmed');
});
it('duplicate withdrawal creation returns recovery state without dispatching again or obtaining new FX',async()=>{
  const {service,dispatch,ledger}=fixture(true);
  expect((await service.requestWithdrawal(input)).confirmation).toBe('recovery_required');
  expect(dispatch.dispatch).not.toHaveBeenCalled();expect(ledger.dispatchIntent).toHaveBeenCalledWith('owner','reference',false);
});
it.each([0,4.99,5.001,NaN,Infinity,21474836.48])('invalid amount %s cannot reach reservation',async amountUsd=>{
  const {service,ledger}=fixture();await expect(service.requestWithdrawal({...input,amountUsd})).rejects.toThrow();expect(ledger.reserve).not.toHaveBeenCalled();
});
it('all owner endpoint identities derive from the verified request, never body identity',async()=>{
  const {service,ledger,dispatch}=fixture();const controller=new WithdrawalsController(service),req={user:{sub:'verified-owner'}};
  await controller.requestWithdrawal(req,{requestId:'request',bankAccountId:'bank',amountUsd:5,quoteId:'quote',userId:'forged'} as any);
  expect(ledger.reserve).toHaveBeenCalledWith('verified-owner','request','bank',500,'quote');
  await controller.recover(req,'ref');expect(dispatch.recover).toHaveBeenCalledWith('verified-owner','ref');
  await controller.dispatch(req,'ref');expect(dispatch.dispatch).toHaveBeenCalledWith('verified-owner','ref');
  await controller.cancel(req,'ref');expect(ledger.cancel).toHaveBeenCalledWith('verified-owner','ref');
});

it('lost-response recovery uses the owner-bound request identity and never dispatches',async()=>{
 const {service,ledger,dispatch}=fixture();ledger.referenceForRequest=jest.fn(()=> 'bound-reference');
 const controller=new WithdrawalsController(service);
 await controller.recoverRequest({user:{sub:'verified-owner'}},'original-request-id');
 expect(ledger.referenceForRequest).toHaveBeenCalledWith('verified-owner','original-request-id');
 expect(dispatch.recover).toHaveBeenCalledWith('verified-owner','bound-reference');
 expect(dispatch.dispatch).not.toHaveBeenCalled();expect(ledger.reserve).not.toHaveBeenCalled();
});

it('durable request references isolate owners and reject malformed identities',()=>{
 const ledger=new WithdrawalLedgerService({} as any,{} as any,{} as any);
 const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',request='abcdefab-abcd-4abc-8abc-abcdefabcdef';
 const reference=ledger.referenceForRequest(owner,request);
 expect(reference).toMatch(/^wd_[a-f0-9]{40}$/);
 expect(ledger.referenceForRequest(owner,request.toUpperCase())).toBe(reference);
 expect(ledger.referenceForRequest(other,request)).not.toBe(reference);
 expect(()=>ledger.referenceForRequest(owner,'invalid')).toThrow();
});

it('refund evidence cannot be registered by forged operator identities in an owner request', async () => {
  const service:any={registerRefundEvidence:jest.fn()};const controller=new WithdrawalsController(service);
  await expect(controller.registerRefundEvidence({user:{sub:'owner',role:'admin'}},'wd_'+'a'.repeat(40),{
    transferCode:'TRF_fixture',outcome:'failed',providerEvidenceId:'unverified',preparedBy:'operator-one',reviewedBy:'operator-two',retainedFeeKobo:0,retainedStampDutyKobo:0,
  })).rejects.toThrow('authorized independent operator review');
  expect(service.registerRefundEvidence).not.toHaveBeenCalled();
});

it('refund preparation and approval ignore body identities and use the verified subject', async () => {
  const review:any={prepare:jest.fn(),approve:jest.fn(),read:jest.fn()};
  const controller=new WithdrawalsController({} as any,review);
  await controller.prepareRefund({user:{sub:'verified-preparer'}},'ref',{providerEvidenceId:'record',retainedFeeKobo:0,retainedStampDutyKobo:0,preparedBy:'forged',reviewedBy:'forged'} as any);
  expect(review.prepare).toHaveBeenCalledWith('verified-preparer','ref',{providerEvidenceId:'record',retainedFeeKobo:0,retainedStampDutyKobo:0});
  await controller.approveRefund({user:{sub:'verified-reviewer'}},'ref',{draftId:'draft',reviewedBy:'forged'} as any);
  expect(review.approve).toHaveBeenCalledWith('verified-reviewer','ref','draft');
});
