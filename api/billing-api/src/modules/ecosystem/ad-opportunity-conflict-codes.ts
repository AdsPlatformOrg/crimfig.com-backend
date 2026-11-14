export const opportunityConflictCodes = [
  'BILLING_SUPPLY_INELIGIBLE',
  'BILLING_TRAFFIC_RESTRICTED',
  'BILLING_ACCOUNT_INELIGIBLE',
  'BILLING_DEADLINE_INVALID',
  'BILLING_DECISION_POLICY_MISMATCH',
  'BILLING_DECISION_BINDING_MISMATCH',
  'BILLING_IDENTITY_CONFLICT',
  'BILLING_CAMPAIGN_INELIGIBLE',
  'BILLING_CREATIVE_INELIGIBLE',
  'BILLING_CREATIVE_NOT_FOUND',
  'BILLING_CREATIVE_VIDEO_DISABLED',
  'BILLING_CREATIVE_INACTIVE',
  'BILLING_CREATIVE_NOT_APPROVED',
  'BILLING_CREATIVE_STACK_NOT_FOUND',
  'BILLING_CREATIVE_STACK_ARCHIVED',
  'BILLING_CREATIVE_STACK_MISMATCH',
  'BILLING_CREATIVE_FORMAT_MISMATCH',
  'BILLING_CREATIVE_SLOT_TYPES_INVALID',
  'BILLING_CREATIVE_TYPE_NOT_ALLOWED',
  'BILLING_ESCROW_INACTIVE',
  'BILLING_FUNDING_PROOF_INVALID',
  'BILLING_FUNDING_PROOF_UNAVAILABLE',
  'BILLING_QUOTE_INVALID',
  'BILLING_CAPACITY_UNAVAILABLE',
  'INSUFFICIENT_RESERVABLE_ESCROW',
  'DAILY_BUDGET_EXHAUSTED',
  'HOURLY_PACING_EXHAUSTED',
  'FREQUENCY_CAP_REACHED',
  'BILLING_MEDIA_UNAVAILABLE',
  'BILLING_RENDITION_INVALID',
] as const;

export type OpportunityConflictCode = (typeof opportunityConflictCodes)[number];

export interface OpportunityCapacityDetails {
  limitType: 'reservable_escrow' | 'daily_budget' | 'hourly_pacing' | 'frequency_cap';
  unit: 'usd_nanos' | 'impressions_per_day';
  allowanceNanos?: string;
  usedOrReservedNanos?: string;
  requestedNanos?: string;
  availableNanos?: string;
  outstandingReservedNanos?: string;
  carryNanos?: string;
  remainingBudgetNanos?: string;
  allowanceCount?: number;
  usedCount?: number;
  requestedCount?: number;
  availableCount?: number;
  decision: 'rejected_house_fallback';
}
