import {approvedAdPolicy} from '@crimfig/shared';
/** Code capability and owner release approval are independent. No default enables paid delivery. */
export function paidDeliveryReadiness(env:Record<string,string|undefined>=process.env) {
  const requested=(env.ADS_PAID_SERVING_ENABLED||'false').trim().toLowerCase()==='true';
  const policy=approvedAdPolicy(env);
  const configured=!!env.INTERNAL_ECOSYSTEM_KEY&&!!env.BILLING_API_URL&&Buffer.byteLength(env.ADS_EVIDENCE_HASH_SECRET||'')>=32;
  const releaseApproved=env.ADS_PAID_RELEASE_ENABLED==='true';
  return {requested,ready:requested&&configured&&!!policy&&releaseApproved,reason:!requested?'PAID_SERVING_DISABLED':!policy?'POLICY_APPROVAL_REQUIRED':!configured?'AUTHORITY_CONFIGURATION_REQUIRED':!releaseApproved?'RELEASE_APPROVAL_REQUIRED':'READY'};
}
