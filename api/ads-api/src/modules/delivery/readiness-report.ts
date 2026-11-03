export type ReadinessStatus = 'eligible' | 'blocked' | 'action_required' | 'pending' | 'unknown' | 'stale' | 'unavailable' | 'observed';

export function readinessReport(scope: 'campaign' | 'website' | 'slot', entityId: string, evaluatedAt: Date) {
  const gates: ReturnType<typeof gate>[] = [];
  function gate(
    gateCode: string,
    status: ReadinessStatus,
    explanation: string,
    owner: string,
    source: string,
    action?: 'verify_email' | 'open_slot' | 'review_website' | 'review_campaign',
    observedAt?: Date,
  ) {
    return {
      gateCode, status, explanation, owner, source, action,
      observedAt: observedAt?.toISOString() ?? null,
      freshness: status === 'stale' ? 'stale' : observedAt ? 'historical' : status === 'unknown' ? 'unverified' : 'evaluated',
    };
  }
  return {
    add(...args: Parameters<typeof gate>) { gates.push(gate(...args)); },
    result() { return { version: 1, scope, entityId, evaluatedAt: evaluatedAt.toISOString(), gates }; },
  };
}
export function websiteReadiness(report: ReturnType<typeof readinessReport>, website: {
  verificationStatus?: unknown;
  verificationExpiresAt?: unknown;
  policyStatus?: unknown;
  isSuspended?: unknown;
  isActive?: unknown;
}, now: Date, staff: boolean) {
  const expiry = new Date(String(website.verificationExpiresAt ?? '')).getTime();
  const ownership = website.verificationStatus === 'verified' && expiry > now.getTime();
  report.add('WEBSITE_OWNERSHIP', ownership ? 'eligible' : 'action_required',
    ownership ? 'Domain ownership proof is current.' : 'Renew or complete domain ownership verification.',
    'Promoter', 'Website ownership record');
  const approved = website.policyStatus === 'approved' && website.isSuspended !== true && website.isActive === true;
  report.add('WEBSITE_SUITABILITY', approved ? 'eligible' : website.policyStatus === 'pending_approval' ? 'pending' : 'blocked',
    approved ? 'Website is approved and active.' : 'Paid delivery requires an active website with suitability approval.',
    'Ads staff', 'Website policy record', !approved && staff ? 'review_website' : undefined);
}

export function installationReadiness(report: ReturnType<typeof readinessReport>, slot: {
  lifecycleStatus?: unknown;
  installationStatus?: unknown;
  installationCheckedAt?: unknown;
  isActive?: unknown;
}, now: Date) {
  const active = slot.lifecycleStatus === 'active' && slot.isActive === true;
  report.add('SLOT_ACTIVE', active ? 'eligible' : 'blocked',
    active ? 'Slot is active.' : 'Slot must be active for paid delivery.', 'Promoter', 'Slot lifecycle');
  const verified = slot.installationStatus === 'verified';
  const checked = new Date(String(slot.installationCheckedAt ?? ''));
  const hasTime = Number.isFinite(checked.getTime()) && checked <= now;
  const fresh = hasTime && now.getTime() - checked.getTime() < 24 * 60 * 60 * 1000;
  report.add('SLOT_INSTALLATION', !verified ? 'action_required' : fresh ? 'observed' : 'stale',
    !verified ? 'Run Test Installation from the owning promoter account.'
      : fresh ? 'Installation was confirmed by a recent check.' : 'The prior installation result needs a fresh check.',
    'Promoter', 'Slot installation record', 'open_slot', hasTime ? checked : undefined);
}
