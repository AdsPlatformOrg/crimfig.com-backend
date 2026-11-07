import { AuctionCandidate, AuctionEngineService, ExcludedCandidateAudit } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';

describe('PLAN0096 mobile selection and candidate elimination', () => {
  const engine = new AuctionEngineService();
  const candidate = (extra: Record<string, unknown> = {}): AuctionCandidate => ({ campaignId: 'campaign', creativeId: 'creative', ownerId: 'owner',
    headline: 'Fixture', destinationUrl: 'https://example.test', pricingVersion: 2, pricingModel: 'cpc',
    costPerClickUsdCents: 10, costPerImpressionUsdCents: 50, remainingBudgetUsdCents: 1000, format: 'banner', targetDevices: ['desktop','mobile'], ...extra });
  const context = (device?: 'desktop'|'android'|'ios'|'tablet') => ({ slotHandle: 'fixture', requestId: 'fixture-request', clientDevice: device, requestedAt: new Date('2026-11-06T12:00:00Z') });
  function service() {
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) };
    return new DeliveryService(db as any, {} as any, engine, {} as any) as any;
  }
  test.each([undefined, 'desktop' as const])('explicit iOS targeting rejects %s and retains the actual reason', device => {
    const exclusions: ExcludedCandidateAudit[] = [];
    expect(engine.resolveAuction([candidate({ targetDevices: ['ios'] })], context(device), null, exclusions)).toBeNull();
    expect(exclusions).toEqual([{ campaignId: 'campaign', creativeId: 'creative', reasonCode: 'DEVICE_MISMATCH' }]);
  });
  test.each(['{', '[1]', '"mobile"'])('malformed targeting %s is rejected before auction', async value => {
    const rejected: any[] = [];
    expect(await service().filterEligibleCandidates([candidate({targetDevices:value})], {device:'android'}, rejected)).toEqual([]);
    expect(rejected[0].reasonCode).toBe('INVALID_TARGETING');
  });
  test.each(['[24]', '[null]', '{'])('invalid hours %s fail closed', async hours => {
    const rejected: any[] = [];
    expect(await service().filterEligibleCandidates([candidate({targetHours:hours})], {device:'android'}, rejected)).toEqual([]);
    expect(rejected[0].reasonCode).toBe('INVALID_TARGETING');
  });
  test('stack device override is respected', async () => {
    const rejected: any[] = [];
    expect(await service().filterEligibleCandidates([candidate({stackTargetDevices:'["desktop"]'})],{device:'android'},rejected)).toEqual([]);
    expect(rejected[0].reasonCode).toBe('DEVICE_MISMATCH');
  });
  test.each(['android','ios','tablet','desktop'] as const)('%s survives both targeting stages for desktop/mobile supply', async device => {
    const filtered = await service().filterEligibleCandidates([candidate()], {device});
    expect(filtered).toHaveLength(1);
    const result = engine.resolveAuction(filtered, context(device));
    expect(result?.winner.creativeId).toBe('creative');
    expect(result?.decisionSnapshot.eligibleGroupCount).toBe(1);
  });
  test.each([['desktop','mobile'], '["desktop","mobile"]', null, []])('stored device representation %j remains supported', async targetDevices => {
    const filtered = await service().filterEligibleCandidates([candidate({targetDevices})], {device:'android'});
    expect(engine.resolveAuction(filtered, context('android'))).not.toBeNull();
  });
  test('explicit empty stack device list overrides inherited campaign restriction', async () => {
    const filtered = await service().filterEligibleCandidates([candidate({targetDevices:['desktop'],stackTargetDevices:'[]'})], {device:'android'});
    expect(engine.resolveAuction(filtered, context('android'))).not.toBeNull();
  });
  test.each([
    [{targetCountries:['NG']}, {clientGeoCountry:'US'}, 'COUNTRY_MISMATCH'],
    [{hourlyPacingUsdCents:1,currentHourSpendUsdCents:1}, {}, 'HOURLY_PACING_EXHAUSTED'],
    [{frequencyCapPerDay:1,viewerDailyImpressions:1}, {}, 'FREQUENCY_CAP_REACHED'],
    [{targetHours:[23]}, {}, 'SCHEDULE_MISMATCH'],
  ])('mobile eligibility preserves other exclusions', (extra, ctx, reason) => {
    const exclusions: ExcludedCandidateAudit[] = [];
    expect(engine.resolveAuction([candidate(extra as any)], {...context('android'),...ctx as any}, null, exclusions)).toBeNull();
    expect(exclusions[0].reasonCode).toBe(reason);
  });
  test('country matching is consistent across targeting and auction', async () => {
    const filtered = await service().filterEligibleCandidates([candidate({targetCountries:'["ng"]'})], {device:'android',country:'NG'});
    expect(engine.resolveAuction(filtered, {...context('android'),clientGeoCountry:'NG'})).not.toBeNull();
  });
  test('stack hour overrides remain effective for mobile', async () => {
    const filtered = await service().filterEligibleCandidates([candidate({targetHours:'[23]',stackTargetHours:'[13]'})], {device:'android'});
    expect(engine.resolveAuction(filtered, context('android'))).not.toBeNull();
  });
  test('recorded stage metadata participates in integrity and deterministic replay', () => {
    const ctx = { ...context('android'), deliveryEvaluation: {device:'android',deviceSource:'user_agent' as const,auctionPolicyVersion:'fixture',
      counts:{discovered:1,targetingEligible:1,creativeCompatible:1,auctionEntered:1,eligibleGroups:0},preAuctionExclusions:[]} };
    const result = engine.resolveAuction([candidate()],ctx)!;
    expect(result.decisionSnapshot.evaluatedCandidates[0].deliveryEvaluation?.counts.eligibleGroups).toBe(1);
    expect(engine.verifyDecisionSnapshotIntegrity(result.decisionSnapshot)).toBe(true);
    expect(engine.replayAuctionDecision([candidate()],context('android'),result.decisionSnapshot).matches).toBe(true);
  });
});
