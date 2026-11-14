export type AcquisitionSourceClass =
  | 'search'
  | 'social'
  | 'referral'
  | 'direct_or_unknown'
  | 'publisher_campaign';

export type TrafficQualityDisposition = 'eligible' | 'quarantined' | 'invalid';
export type TrafficQualityEnforcementMode = 'report_only' | 'enforced';

export interface ThreeReferrerSignals {
  initialPageReferrerOrigin: string | null;
  sdkEventReferrerOrigin: string | null;
  clickRedirectReferrerOrigin: string | null;
  acquisitionSourceClass: AcquisitionSourceClass;
  untrustedUtmHint: string | null;
}

const SEARCH_HOSTS = new Set([
  'google.com', 'www.google.com', 'bing.com', 'www.bing.com',
  'duckduckgo.com', 'search.yahoo.com', 'yandex.com', 'www.baidu.com',
  'www.ecosia.org', 'search.brave.com',
]);

const SOCIAL_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'l.facebook.com', 'lm.facebook.com',
  'instagram.com', 'www.instagram.com', 'l.instagram.com',
  'wa.me', 'web.whatsapp.com', 'api.whatsapp.com',
  't.me', 'web.telegram.org',
  'twitter.com', 'x.com', 't.co',
  'linkedin.com', 'www.linkedin.com', 'lnkd.in',
  'tiktok.com', 'www.tiktok.com',
  'reddit.com', 'www.reddit.com',
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'threads.net', 'www.threads.net',
]);

/**
 * Strips paths, query parameters, fragments, and credentials, returning only
 * `scheme://host[:port]` for http/https URLs, or `null` when missing/invalid.
 */
export function sanitizeReferrerOrigin(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function classifyAcquisitionSource(
  initialOrigin: string | null,
  utmSource?: string | null,
  utmMedium?: string | null,
): { acquisitionSourceClass: AcquisitionSourceClass; untrustedUtmHint: string | null } {
  const hintParts = [utmSource, utmMedium]
    .map((v) => (typeof v === 'string' ? v.trim().slice(0, 64) : ''))
    .filter(Boolean);
  const untrustedUtmHint = hintParts.length > 0 ? hintParts.join('/') : null;

  if (!initialOrigin) {
    // Missing referrer must remain Unknown, never Fraud.
    return { acquisitionSourceClass: 'direct_or_unknown', untrustedUtmHint };
  }

  let hostname = '';
  try {
    hostname = new URL(initialOrigin).hostname.toLowerCase();
  } catch {
    return { acquisitionSourceClass: 'direct_or_unknown', untrustedUtmHint };
  }

  if (SEARCH_HOSTS.has(hostname) || hostname.startsWith('www.google.') || hostname.startsWith('google.')) {
    return { acquisitionSourceClass: 'search', untrustedUtmHint };
  }
  if (SOCIAL_HOSTS.has(hostname)) {
    return { acquisitionSourceClass: 'social', untrustedUtmHint };
  }
  return { acquisitionSourceClass: 'referral', untrustedUtmHint };
}

export function buildThreeReferrerSignals(input: {
  initialPageReferrer?: string | null;
  sdkEventReferrer?: string | null;
  clickRedirectReferrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
}): ThreeReferrerSignals {
  const initialPageReferrerOrigin = sanitizeReferrerOrigin(input.initialPageReferrer);
  const sdkEventReferrerOrigin = sanitizeReferrerOrigin(input.sdkEventReferrer);
  const clickRedirectReferrerOrigin = sanitizeReferrerOrigin(input.clickRedirectReferrer);
  const { acquisitionSourceClass, untrustedUtmHint } = classifyAcquisitionSource(
    initialPageReferrerOrigin,
    input.utmSource,
    input.utmMedium,
  );
  return {
    initialPageReferrerOrigin,
    sdkEventReferrerOrigin,
    clickRedirectReferrerOrigin,
    acquisitionSourceClass,
    untrustedUtmHint,
  };
}

export interface PublisherCohortMetrics {
  promoterId: string;
  websiteId: string;
  visitorCount: number;
  distinctIpCount: number;
  clickCount: number;
  baselineCtr: number; // e.g. 0.02 (2%)
  medianRenderToClickMs: number | null;
  synchronizedBurstRatio: number; // 0..1
  dominantSourceShare: number; // 0..1
  dominantSourceClass: AcquisitionSourceClass;
  asnConcentrationRatio: number; // 0..1
  continuityRepeatClickCount: number;
  distinctCampaignsClicked: number;
  advertiserDisputeCount: number;
}

export interface PublisherTrafficAssessment {
  modelVersion: string;
  enforcementMode: TrafficQualityEnforcementMode;
  disposition: TrafficQualityDisposition;
  wouldQuarantineIfEnforced: boolean;
  highSignals: string[];
  supportingSignals: string[];
  clickToVisitRatio: number;
}

export function assessPublisherTrafficQuality(
  cohort: PublisherCohortMetrics,
  enforcementMode: TrafficQualityEnforcementMode = 'report_only',
): PublisherTrafficAssessment {
  const clickToVisitRatio = cohort.visitorCount > 0 ? cohort.clickCount / cohort.visitorCount : 0;
  const highSignals: string[] = [];
  const supportingSignals: string[] = [];

  // 1. Publisher-level click pattern (e.g. 30 visitors / 30 IPs / 27 clicks = 90% CTR)
  if (
    cohort.visitorCount >= 10 &&
    cohort.clickCount >= 5 &&
    (clickToVisitRatio >= 0.45 || (cohort.baselineCtr > 0 && clickToVisitRatio >= cohort.baselineCtr * 3))
  ) {
    highSignals.push('publisher_ctr_spike');
  }
  // 2. Group behavior: synchronized click bursts across distinct IPs/devices
  if (cohort.distinctIpCount >= 5 && cohort.synchronizedBurstRatio >= 0.6) {
    highSignals.push('group_timing_cluster');
  }
  // 3. Landing-page behavior: immediate click with near-zero engagement
  if (cohort.medianRenderToClickMs !== null && cohort.medianRenderToClickMs < 1500 && cohort.clickCount >= 5) {
    highSignals.push('low_landing_engagement');
  }
  // 4. Referrer & acquisition source (supporting only, never standalone)
  if (cohort.dominantSourceShare >= 0.85 && cohort.clickCount >= 5 && cohort.dominantSourceClass !== 'search') {
    supportingSignals.push('acquisition_source_concentration');
  }
  // 5. Network intelligence (supporting only)
  if (cohort.asnConcentrationRatio >= 0.7 && cohort.distinctIpCount >= 5) {
    supportingSignals.push('network_asn_cluster');
  }
  // 6. Session continuity repeat clicks
  if (cohort.continuityRepeatClickCount >= 3) {
    highSignals.push('session_continuity_repeat');
  }
  // 7. Cross-campaign sweep
  if (cohort.distinctCampaignsClicked >= 3 && cohort.clickCount >= 5) {
    highSignals.push('cross_campaign_sweep');
  }
  // 8. Advertiser feedback (supporting only)
  if (cohort.advertiserDisputeCount >= 1) {
    supportingSignals.push('advertiser_dispute_signal');
  }

  // Require multiple corroborating signals: >= 2 high signals, OR 1 high + >= 2 supporting.
  const wouldQuarantineIfEnforced =
    highSignals.length >= 2 || (highSignals.length >= 1 && supportingSignals.length >= 2);

  const disposition: TrafficQualityDisposition =
    enforcementMode === 'enforced' && wouldQuarantineIfEnforced ? 'quarantined' : 'eligible';

  return {
    modelVersion: 'ptq-v1',
    enforcementMode,
    disposition,
    wouldQuarantineIfEnforced,
    highSignals,
    supportingSignals,
    clickToVisitRatio,
  };
}

