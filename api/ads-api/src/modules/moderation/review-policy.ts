/** Stable existing codes. Historical decision records are never relabelled. */
export const REVIEW_REASONS = Object.freeze([
  {code:'POLICY_VIOLATION',label:'Policy violation'},
  {code:'MISLEADING',label:'Misleading content'},
  {code:'PROHIBITED',label:'Prohibited material'},
  {code:'BROKEN_URL',label:'Destination issue'},
  {code:'LOW_QUALITY',label:'Creative quality or completeness'},
  {code:'TRADEMARK',label:'Trademark or identity concern'},
  {code:'BUDGET_OR_TARGETING_ISSUE',label:'Budget or targeting issue'},
]);
export function reviewOptions(){return {reasons:REVIEW_REASONS,noteMaxLength:2000,customExplanationAllowed:true};}
export function knownReviewReason(code:string){return REVIEW_REASONS.some(reason=>reason.code===code);}
