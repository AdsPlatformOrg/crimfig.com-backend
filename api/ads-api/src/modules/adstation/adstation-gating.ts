export type DirectSlotDisplayStatus =
  | 'Draft'
  | 'Published — Pending Review'
  | 'Approved — Network Not Active'
  | 'Ready to Go Live'
  | 'Live'
  | 'Paused'
  | 'Rejected';

export interface DirectSlotGatingInput {
  id: string;
  websiteId: string;
  slotType: string;
  lifecycleStatus: string;
  isActive: boolean;
  policyRevision: number;
  manualReviewStatus?: string | null;
  approvedRevision?: number | null;
  reviewReason?: string | null;
}

export interface WebsiteGatingInput {
  id: string;
  isActive: boolean;
  isSuspended: boolean;
  verificationStatus: string;
  verificationExpiresAt: Date | string | null;
  policyStatus: string;
}

export interface NetworkSlotCandidate {
  id: string;
  websiteId: string;
  slotType: string;
  lifecycleStatus: string;
  isActive: boolean;
  installationStatus: string;
  isConsiderationVerified?: boolean;
}

export interface DirectSlotReadinessEvaluation {
  networkActiveOnWebsite: boolean;
  manualReviewApprovedOnCurrentRevision: boolean;
  liveEligible: boolean;
  displayStatus: DirectSlotDisplayStatus;
  blockerReasons: string[];
}

export function isWebsiteEligibleForAdNetwork(
  website: WebsiteGatingInput | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!website) return false;
  if (!website.isActive || website.isSuspended) return false;
  if (website.verificationStatus !== 'verified') return false;
  if (!website.verificationExpiresAt) return false;
  const expiresAt =
    website.verificationExpiresAt instanceof Date
      ? website.verificationExpiresAt
      : new Date(website.verificationExpiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return false;
  return website.policyStatus === 'approved';
}

export function isWebsiteNetworkOperational(
  website: WebsiteGatingInput | null | undefined,
  websiteSlots: NetworkSlotCandidate[],
  now: Date = new Date(),
): boolean {
  if (!isWebsiteEligibleForAdNetwork(website, now)) return false;
  const targetWebsiteId = website!.id;
  return websiteSlots.some(
    (candidate) =>
      candidate.websiteId === targetWebsiteId &&
      ['network', 'consideration', 'hybrid'].includes(candidate.slotType) &&
      candidate.isActive === true &&
      candidate.lifecycleStatus === 'active' &&
      (candidate.installationStatus === 'verified' || candidate.isConsiderationVerified === true),
  );
}

export function isDirectSlotRevisionApproved(
  slot: Pick<DirectSlotGatingInput, 'manualReviewStatus' | 'approvedRevision' | 'policyRevision'>,
): boolean {
  return (
    slot.manualReviewStatus === 'approved' &&
    slot.approvedRevision !== null &&
    slot.approvedRevision !== undefined &&
    Number(slot.approvedRevision) === Number(slot.policyRevision)
  );
}

export function evaluateDirectSlotReadiness(
  slot: DirectSlotGatingInput,
  website: WebsiteGatingInput | null | undefined,
  websiteSlots: NetworkSlotCandidate[],
  now: Date = new Date(),
): DirectSlotReadinessEvaluation {
  const networkActiveOnWebsite = isWebsiteNetworkOperational(website, websiteSlots, now);
  const manualReviewApprovedOnCurrentRevision = isDirectSlotRevisionApproved(slot);
  const liveEligible = networkActiveOnWebsite && manualReviewApprovedOnCurrentRevision;

  const blockerReasons: string[] = [];
  if (!networkActiveOnWebsite) {
    blockerReasons.push(
      'Active, verified, and operational CrimFig Ad Network integration is required on this same website.',
    );
  }
  if (!manualReviewApprovedOnCurrentRevision) {
    if (slot.manualReviewStatus === 'rejected') {
      blockerReasons.push(
        slot.reviewReason || 'This direct ad slot revision was rejected during manual review.',
      );
    } else if (
      slot.manualReviewStatus === 'approved' &&
      slot.approvedRevision !== slot.policyRevision
    ) {
      blockerReasons.push(
        'Material changes were made since last approval; manual re-review is required on the current revision.',
      );
    } else {
      blockerReasons.push('Manual review approval is required on the current revision.');
    }
  }

  let displayStatus: DirectSlotDisplayStatus;
  if (slot.manualReviewStatus === 'rejected') {
    displayStatus = 'Rejected';
  } else if (slot.lifecycleStatus === 'draft') {
    displayStatus = 'Draft';
  } else if (['paused', 'disabled', 'suspended'].includes(slot.lifecycleStatus)) {
    displayStatus = 'Paused';
  } else if (slot.lifecycleStatus === 'active' && liveEligible) {
    displayStatus = 'Live';
  } else if (liveEligible) {
    displayStatus = 'Ready to Go Live';
  } else if (manualReviewApprovedOnCurrentRevision && !networkActiveOnWebsite) {
    displayStatus = 'Approved — Network Not Active';
  } else {
    displayStatus = 'Published — Pending Review';
  }

  return {
    networkActiveOnWebsite,
    manualReviewApprovedOnCurrentRevision,
    liveEligible,
    displayStatus,
    blockerReasons,
  };
}

