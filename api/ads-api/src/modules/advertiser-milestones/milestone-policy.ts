import type { MilestoneEvidence } from './milestone-evidence';
export const recognitionPolicyVersion = 'advertiser-recognition-v1';
export const milestoneDefinitions = [
  { tier: 'A1_FIRST_CAMPAIGN', title: 'First Campaign', campaignTarget: 1, minimumCampaignSpendCents: 500,
    requirement: 'Complete one approved campaign with at least $5.00 in eligible cleared cash-funded spend.' },
  { tier: 'A2_CONSISTENT', title: 'Consistent Advertiser', campaignTarget: 3, minimumCampaignSpendCents: null,
    requirement: 'Complete three distinct eligible campaigns with verified clearance.' },
  ...[100, 1000, 10000].map(count => ({ tier: 'PRESTIGE_' + count, title: count.toLocaleString('en-US') + ' Campaigns',
    campaignTarget: count, minimumCampaignSpendCents: null,
    requirement: 'Complete ' + count.toLocaleString('en-US') + ' distinct eligible campaigns.' })),
];
export function recognitionDecisions(evidence: MilestoneEvidence) {
  const unique = new Map(evidence.campaigns.map(campaign => [campaign.id, campaign]));
  const eligible = [...unique.values()].filter(campaign => evidence.fundingVerified && campaign.completed && campaign.eligible
    && Number.isSafeInteger(campaign.clearedSpendCents) && campaign.clearedSpendCents! > 0);
  return milestoneDefinitions.map(definition => ({ ...definition,
    qualified: definition.minimumCampaignSpendCents === null ? eligible.length >= definition.campaignTarget
      : eligible.some(campaign => campaign.clearedSpendCents! >= definition.minimumCampaignSpendCents!),
  }));
}
