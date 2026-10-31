import {paidDeliveryReadiness} from '../../../api/ads-api/src/modules/delivery/paid-delivery-policy';
import {AuctionEngineService} from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import {DeliveryService} from '../../../api/ads-api/src/modules/delivery/delivery.service';
import {ForbiddenException} from '@nestjs/common';
const now=new Date('2026-10-30T12:00:00Z');
const reservation={opportunityId:'opportunity',campaignId:'campaign',remainingBudgetUsdCents:100,pricingModel:'cpc' as const,reservedNanos:100000000n,now};
describe('PLAN-0049 paid release gate and simulated reservation regressions — failures first',()=>{
  it.each([undefined,'true','TRUE','false'])('does not certify a simulated ledger for paid issuance with flag %s',value=>{
    expect(paidDeliveryReadiness({ADS_PAID_SERVING_ENABLED:value}).ready).toBe(false);
  });
  it('legacy tokens and client mode parameters cannot bypass the paid release gate',async()=>{
    const db:any={select:jest.fn(),insert:jest.fn()};const tokens:any={assertConfigured:jest.fn()};
    const service=new DeliveryService(db,tokens,new AuctionEngineService(),{} as any);
    await expect(service.getAdForPlacement('legacy-token','203.0.113.1','Browser','jed.com.ng','network',true)).rejects.toThrow(ForbiddenException);
    expect(db.select).not.toHaveBeenCalled();expect(db.insert).not.toHaveBeenCalled();
  });
  it('rejects invalid, zero, oversized and non-finite reservation inputs without holding exposure',()=>{
    const auction=new AuctionEngineService();
    for(const patch of [{ttlMs:0},{ttlMs:-1},{ttlMs:900001},{ttlMs:NaN},{remainingBudgetUsdCents:NaN},{remainingBudgetUsdCents:-1},{reservedNanos:0n},{opportunityId:''},{now:new Date(NaN)}])expect(()=>auction.reserveSimulatedOpportunityExposure({...reservation,...patch})).toThrow(RangeError);
    expect(auction.getActiveSimulatedReservedNanos('campaign',now)).toBe(0n);
  });
  it('rejects reuse of an opportunity ID for another campaign, amount, model or binding',()=>{
    const auction=new AuctionEngineService();auction.reserveSimulatedOpportunityExposure(reservation);
    for(const patch of [{campaignId:'other'},{reservedNanos:200000000n},{pricingModel:'cpm' as const},{serveId:'other'},{escrowId:'other'}])expect(()=>auction.reserveSimulatedOpportunityExposure({...reservation,...patch})).toThrow('different reservation');
    expect(auction.getActiveSimulatedReservedNanos('campaign',now)).toBe(100000000n);
  });
  it('expired/released reservations cannot be claimed or silently reopened',()=>{
    const auction=new AuctionEngineService();auction.reserveSimulatedOpportunityExposure({...reservation,ttlMs:1});
    const later=new Date(now.getTime()+1);expect(()=>auction.claimSimulatedOpportunityExposure('opportunity',later)).toThrow('EXPIRED');
    expect(()=>auction.reserveSimulatedOpportunityExposure({...reservation,now:later})).toThrow('closed');
    auction.reserveSimulatedOpportunityExposure({...reservation,opportunityId:'released'});auction.releaseSimulatedOpportunityExposure('released','invalid',now);
    expect(()=>auction.claimSimulatedOpportunityExposure('released',now)).toThrow('RELEASED');
  });
  it('replays the same live reservation exactly and accepts a new opportunity after expiry',()=>{
    const auction=new AuctionEngineService();const first=auction.reserveSimulatedOpportunityExposure(reservation);
    expect(auction.reserveSimulatedOpportunityExposure(reservation).id).toBe(first.id);
    const later=new Date(now.getTime()+900000);expect(auction.getActiveSimulatedReservedNanos('campaign',later)).toBe(0n);
    expect(auction.reserveSimulatedOpportunityExposure({...reservation,opportunityId:'new',now:later}).state).toBe('HELD');
  });
});
