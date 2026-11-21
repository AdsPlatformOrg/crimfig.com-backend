import {ownershipMethodStatuses,proofTokenHash} from '../../../api/ads-api/src/modules/verification/ownership-method-status';
describe('Independent ownership method evidence',()=>{
  const now=Date.parse('2026-11-21T12:00:00Z'),site={id:'site',verificationToken:'current-token',verificationMethod:'dns_txt',verificationStatus:'verified',verificationExpiresAt:new Date(now+86400000)};
  const check=(method:string,status:string,token='current-token',at=now-1000)=>({entityId:'site',dimension:`ownership_check_${method}`,toState:status,reason:proofTokenHash(token),createdAt:new Date(at)});
  test('HTML success and DNS failure override a stale preferred DNS method independently',()=>{
    const result=ownershipMethodStatuses(site,[check('html_meta','verified'),check('dns_txt','not_verified')],now);
    expect(result.html_meta.status).toBe('verified');expect(result.dns_txt.status).toBe('not_verified');
  });
  test('expired or rotated-token proof never gives a method a verified label',()=>{
    const result=ownershipMethodStatuses({...site,verificationStatus:'pending'},[check('html_meta','verified','old-token'),check('dns_txt','verified','current-token',now-31*86400000)],now);
    expect(result.html_meta.status).toBe('not_verified');expect(result.dns_txt.status).toBe('expired');
  });
  test('both methods can be verified; one failed check does not erase the other',()=>{
    expect(ownershipMethodStatuses(site,[check('html_meta','verified'),check('dns_txt','verified')],now).html_meta.status).toBe('verified');
    expect(ownershipMethodStatuses(site,[check('html_meta','not_verified'),check('dns_txt','verified')],now).dns_txt.status).toBe('verified');
  });
});
