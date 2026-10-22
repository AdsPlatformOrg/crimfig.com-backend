import { netWithdrawalQuote, transferCharges } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-fees';

describe('User-funded withdrawal fee quotation', () => {
 it.each([[500000,1000,0],[500001,2500,0],[999999,2500,0],[1000000,2500,5000],[5000000,2500,5000],[5000001,5000,5000]])('prices net payout %s at its actual band', (net,fee,duty)=>{
  expect(transferCharges(net)).toEqual({transferFeeKobo:fee,stampDutyKobo:duty,totalFeeKobo:fee+duty});
 });
 it.each([[500000,499000,1000,0],[1007500,1000000,2500,5000],[5007500,5000000,2500,5000],[10010000,10000000,5000,5000]])('deducts fees from gross %s with exact conservation',(gross,net,fee,duty)=>{
  expect(netWithdrawalQuote(gross)).toMatchObject({grossKobo:gross,netKobo:net,transferFeeKobo:fee,stampDutyKobo:duty});
 });
 it.each([501001,502000,1002500,1005000,5009000])('never retains an artificial charge at discontinuity %s',gross=>{
  expect(()=>netWithdrawalQuote(gross)).toThrow('fee boundary');
 });
 it.each([0,-1,0.5,NaN,Infinity,2147483648])('rejects invalid gross %s',gross=>{
  expect(()=>netWithdrawalQuote(gross)).toThrow();
 });
 it('conserves every quoted kobo across a broad range of gross budgets',()=>{
  let quoted=0;
  for(let gross=10001;gross<6000000;gross+=7919){
   try{const quote=netWithdrawalQuote(gross);expect(quote.netKobo+quote.totalFeeKobo).toBe(gross);expect(transferCharges(quote.netKobo).totalFeeKobo).toBe(quote.totalFeeKobo);quoted++;}
   catch(error){if(!(error as Error).message.includes('fee boundary'))throw error;}
  }
  expect(quoted).toBeGreaterThan(700);
 });
});
