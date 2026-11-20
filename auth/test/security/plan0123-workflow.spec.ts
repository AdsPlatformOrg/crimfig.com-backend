import { displayBurnPercent } from '../../../api/ads-api/src/modules/billing/display-burn-percent';
import { matchesReviewSubmission } from '../../../api/ads-api/src/modules/moderation/moderation-reporting';

describe('PLAN0123 display and scoped review boundaries', () => {
  test('invalid and zero display values never produce NaN or false spend', () => {
    for (const [spent,allocated] of [[0,5000],[-1,5000],[90,0],[NaN,5000],[Infinity,5000]]) {
      expect(displayBurnPercent(spent,allocated)).toBe(0);
    }
  });
  test('ceiling display avoids binary float artifacts and clamps overburn', () => {
    expect(displayBurnPercent(90,5000)).toBe(2);
    expect(displayBurnPercent(5000,5000)).toBe(100);
    expect(displayBurnPercent(6000,5000)).toBe(100);
    expect(displayBurnPercent(1,1000000000)).toBe(1);
  });
  const campaign = {id:'campaign',moderationStatus:'approved',currentSubmissionId:'base',approvedSubmissionId:'base',contentRevision:2,approvedRevision:2};
  const scoped = {id:'asset-review',campaignId:'campaign',contentRevision:2,state:'submitted',snapshot:{scope:{creativeIds:['new-ad'],stackIds:[]}}};
  test('scoped submissions reject another campaign, entity, revision, and withdrawn work', () => {
    for (const submission of [{...scoped,campaignId:'other'},{...scoped,contentRevision:3},{...scoped,state:'withdrawn'}]) {
      expect(matchesReviewSubmission(campaign,submission,'creative','new-ad')).toBe(false);
    }
    expect(matchesReviewSubmission(campaign,scoped,'creative','sibling')).toBe(false);
    expect(matchesReviewSubmission(campaign,scoped,'campaign','campaign')).toBe(false);
    expect(matchesReviewSubmission({...campaign,submissionIntentId:'intent'},scoped,'creative','new-ad')).toBe(false);
  });
  test('a matching asset submission preserves current campaign approval identity', () => {
    expect(matchesReviewSubmission(campaign,scoped,'creative','new-ad')).toBe(true);
    expect(matchesReviewSubmission(campaign,{...scoped,id:'base'},'campaign','campaign')).toBe(true);
  });
});
