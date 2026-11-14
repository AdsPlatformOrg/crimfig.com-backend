import {
  assessPublisherTrafficQuality,
  buildThreeReferrerSignals,
  sanitizeReferrerOrigin,
  type PublisherCohortMetrics,
} from '../../../api/ads-api/src/modules/delivery/traffic-quality-policy';

function makeCohort(overrides: Partial<PublisherCohortMetrics> = {}): PublisherCohortMetrics {
  return {
    promoterId: 'prom-1',
    websiteId: 'site-1',
    visitorCount: 30,
    distinctIpCount: 30,
    clickCount: 2,
    baselineCtr: 0.02,
    medianRenderToClickMs: 8500,
    synchronizedBurstRatio: 0.1,
    dominantSourceShare: 0.5,
    dominantSourceClass: 'social',
    asnConcentrationRatio: 0.2,
    continuityRepeatClickCount: 0,
    distinctCampaignsClicked: 1,
    advertiserDisputeCount: 0,
    ...overrides,
  };
}

describe('PLAN-0111 Publisher Traffic Quality & Coordinated Click Fraud Detection', () => {
  it('strips paths, query strings, fragments, and credentials from initial referrer URLs', () => {
    expect(sanitizeReferrerOrigin('https://l.facebook.com/l.php?u=https%3A%2F%2Fjed.com.ng&h=SECRET_TOKEN#frag')).toBe('https://l.facebook.com');
    expect(sanitizeReferrerOrigin('https://user:pass@www.google.com/search?q=private')).toBe('https://www.google.com');
    expect(sanitizeReferrerOrigin('javascript:alert(1)')).toBeNull();
    expect(sanitizeReferrerOrigin(null)).toBeNull();
  });

  it('keeps missing referrer as direct_or_unknown and never treats WhatsApp/social/unknown as fraud', () => {
    const whatsapp = buildThreeReferrerSignals({
      initialPageReferrer: 'https://wa.me/1234567890',
      sdkEventReferrer: 'https://jed.com.ng/article',
      clickRedirectReferrer: 'https://jed.com.ng/article',
    });
    expect(whatsapp.acquisitionSourceClass).toBe('social');
    expect(whatsapp.initialPageReferrerOrigin).toBe('https://wa.me');
    expect(whatsapp.sdkEventReferrerOrigin).toBe('https://jed.com.ng');
    expect(whatsapp.clickRedirectReferrerOrigin).toBe('https://jed.com.ng');

    const missing = buildThreeReferrerSignals({
      initialPageReferrer: null,
      sdkEventReferrer: 'https://jed.com.ng/article',
      utmSource: 'whatsapp',
      utmMedium: 'share',
    });
    expect(missing.acquisitionSourceClass).toBe('direct_or_unknown');
    expect(missing.untrustedUtmHint).toBe('whatsapp/share');
  });

  it('never quarantines or invalidates a legitimate viral WhatsApp/social cohort on referrer concentration alone', () => {
    const viralSocial = makeCohort({
      visitorCount: 500,
      distinctIpCount: 480,
      clickCount: 10, // 2% CTR, normal
      dominantSourceShare: 0.95,
      dominantSourceClass: 'social',
    });
    const res = assessPublisherTrafficQuality(viralSocial, 'enforced');
    expect(res.wouldQuarantineIfEnforced).toBe(false);
    expect(res.disposition).toBe('eligible');
    expect(res.supportingSignals).toContain('acquisition_source_concentration');
    expect(res.highSignals).toHaveLength(0);
  });

  it('flags 30-visitor / 30-IP / 27-click (90% CTR) coordinated burst in report_only without blocking, and quarantines when enforced', () => {
    const coordinated = makeCohort({
      visitorCount: 30,
      distinctIpCount: 30,
      clickCount: 27, // 90% click-to-visit ratio
      medianRenderToClickMs: 900,
      synchronizedBurstRatio: 0.85,
      dominantSourceShare: 0.9,
      dominantSourceClass: 'social',
      distinctCampaignsClicked: 4,
    });

    const reportOnly = assessPublisherTrafficQuality(coordinated, 'report_only');
    expect(reportOnly.wouldQuarantineIfEnforced).toBe(true);
    expect(reportOnly.disposition).toBe('eligible'); // report-only never blocks
    expect(reportOnly.highSignals).toEqual(
      expect.arrayContaining(['publisher_ctr_spike', 'group_timing_cluster', 'low_landing_engagement', 'cross_campaign_sweep']),
    );

    const enforced = assessPublisherTrafficQuality(coordinated, 'enforced');
    expect(enforced.disposition).toBe('quarantined');
    expect(enforced.clickToVisitRatio).toBeCloseTo(0.9, 5);
  });
});

