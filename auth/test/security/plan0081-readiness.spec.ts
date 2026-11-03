import { installationReadiness, readinessReport, websiteReadiness } from '../../../api/ads-api/src/modules/delivery/readiness-report';

const evaluatedAt = new Date('2026-11-03T10:00:00Z');

test('PLAN0081 old installation evidence is stale without changing active slot eligibility', () => {
  const report = readinessReport('slot', 'fixture', evaluatedAt);
  installationReadiness(report, {
    lifecycleStatus: 'active', isActive: true, installationStatus: 'verified',
    installationCheckedAt: new Date('2026-11-01T10:00:00Z'),
  }, evaluatedAt);
  expect(report.result().gates).toMatchObject([
    { gateCode: 'SLOT_ACTIVE', status: 'eligible' },
    { gateCode: 'SLOT_INSTALLATION', status: 'stale', freshness: 'stale' },
  ]);
});

test('PLAN0081 expired ownership stays actionable and staff alone gets the review action', () => {
  const website = {
    verificationStatus: 'verified', verificationExpiresAt: evaluatedAt, policyStatus: 'pending_approval', isActive: true,
  };
  const owner = readinessReport('website', 'fixture', evaluatedAt);
  const staff = readinessReport('website', 'fixture', evaluatedAt);
  websiteReadiness(owner, website, evaluatedAt, false);
  websiteReadiness(staff, website, evaluatedAt, true);
  expect(owner.result().gates[0]).toMatchObject({ gateCode: 'WEBSITE_OWNERSHIP', status: 'action_required' });
  expect(owner.result().gates[1]).toMatchObject({ gateCode: 'WEBSITE_SUITABILITY', status: 'pending', action: undefined });
  expect(staff.result().gates[1]).toMatchObject({ gateCode: 'WEBSITE_SUITABILITY', status: 'pending', action: 'review_website' });
});
