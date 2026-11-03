import {approvedAdPolicy} from '@crimfig/shared';
/** Code capability and owner release approval are independent. No default enables paid delivery. */
export function paidDeliveryReadiness(env:Record<string,string|undefined>=process.env) {
  const requested=(env.ADS_PAID_SERVING_ENABLED||'false').trim().toLowerCase()==='true';
  const policy=approvedAdPolicy(env);
  const configured=!!env.INTERNAL_ECOSYSTEM_KEY&&!!env.BILLING_API_URL&&Buffer.byteLength(env.ADS_EVIDENCE_HASH_SECRET||'')>=32;
  const releaseApproved=env.ADS_PAID_RELEASE_ENABLED==='true';
  return {requested,ready:requested&&configured&&!!policy&&releaseApproved,reason:!requested?'PAID_SERVING_DISABLED':!policy?'POLICY_APPROVAL_REQUIRED':!configured?'AUTHORITY_CONFIGURATION_REQUIRED':!releaseApproved?'RELEASE_APPROVAL_REQUIRED':'READY'};
}

/** Safe offline diagnostics: booleans/reason codes only; never return configured values. */
export function paidDeliveryDiagnostics(env:Record<string,string|undefined>=process.env){
 const checks={servingRequested:(env.ADS_PAID_SERVING_ENABLED||'false').trim().toLowerCase()==='true',policyApproved:!!approvedAdPolicy(env),billingAuthorityConfigured:!!env.INTERNAL_ECOSYSTEM_KEY&&!!env.BILLING_API_URL,evidenceKeyConfigured:Buffer.byteLength(env.ADS_EVIDENCE_HASH_SECRET||'')>=32,releaseApproved:env.ADS_PAID_RELEASE_ENABLED==='true'};
 const codes={servingRequested:'PAID_SERVING_DISABLED',policyApproved:'POLICY_APPROVAL_REQUIRED',billingAuthorityConfigured:'BILLING_AUTHORITY_CONFIGURATION_REQUIRED',evidenceKeyConfigured:'EVIDENCE_CONFIGURATION_REQUIRED',releaseApproved:'RELEASE_APPROVAL_REQUIRED'};
 const blockers=(Object.keys(checks) as (keyof typeof checks)[]).filter(key=>!checks[key]).map(key=>codes[key]);return {ready:blockers.length===0,checks,blockers};
}
export function slotDeliveryDiagnostics(slot:{lifecycleStatus?:string;isActive?:boolean},website:{verificationStatus?:string;verificationExpiresAt?:Date|string|null;policyStatus?:string;isSuspended?:boolean},env:Record<string,string|undefined>=process.env,now=Date.now()){
 const blockers:string[]=[];const expiry=website.verificationExpiresAt?new Date(website.verificationExpiresAt).getTime():NaN;
 if(website.verificationStatus!=='verified'||!Number.isFinite(expiry)||expiry<=now)blockers.push('WEBSITE_OWNERSHIP_REQUIRED');
 if(website.isSuspended||website.policyStatus==='suspended')blockers.push('WEBSITE_SUSPENDED');
 if(website.policyStatus!=='approved')blockers.push('WEBSITE_APPROVAL_REQUIRED');
 if(slot.lifecycleStatus!=='active'||slot.isActive!==true)blockers.push('SLOT_NOT_ACTIVE');
 if(!paidDeliveryReadiness(env).ready)blockers.push('PLATFORM_PAID_DELIVERY_UNAVAILABLE');
 return {scope:'pre_auction',status:blockers.length?'blocked':'request_checks_pending',blockers,remainingChecks:['TRAFFIC_RISK','CAMPAIGN_CURRENT_APPROVAL','ESCROW_BUDGET','TARGETING_SCHEDULE_DEVICE','FORMAT_PRESET_AND_AUCTION'],message:'These checks do not serve an ad or guarantee a paid fill. Ownership verification does not replace website suitability approval.'};
}
