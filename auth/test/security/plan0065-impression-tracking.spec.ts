import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import {
  performanceRates,
  performanceWindow,
} from '../../../api/ads-api/src/modules/delivery/admin-performance.controller';
import * as vm from 'vm';

describe('PLAN-0065: Impression and Viewable Impression Beacon Tracking Architecture', () => {
  // =========================================================================
  // 1. NEGATIVE / REJECTION / FAILURE ASSERTIONS FIRST (JED, 2026-10-30)
  // =========================================================================

  describe('Negative & Rejection Invariants (Failure First)', () => {
    let fraud: FraudRulesService;
    let tokenService: ImpressionTokenService;

    beforeEach(() => {
      process.env.ADS_IMPRESSION_SIGNING_KEY =
        'test-delivery-token-secret-32-chars-long-valid!';
      fraud = new FraudRulesService();
      tokenService = new ImpressionTokenService();
    });

    it('rejects tampered or forged impToken without authorizing writes', () => {
      const forgedToken = 'imp_eyAiYWxnIjogIkhTMjU2IiB9.eyJzZXJ2ZWRJZCI6ICJmb3JnZWQifQ.invalidsignaturelength43paddingchars1234567';
      const verified = tokenService.verifyToken(forgedToken, '198.51.100.1');
      expect(verified).toBeNull();
    });

    it('rejects impToken presented from a mismatched client IP', () => {
      const token = tokenService.generateToken({
        servedId: '00000000-0000-4000-8000-000000000001',
        placementId: '00000000-0000-4000-8000-000000000002',
        campaignId: '00000000-0000-4000-8000-000000000003',
        creativeId: '00000000-0000-4000-8000-000000000004',
        promoterId: '00000000-0000-4000-8000-000000000005',
        ipHash: tokenService.hashIp('198.51.100.1'),
      });

      // Presenting token from a different client IP must fail verification
      const verifiedWithWrongIp = tokenService.verifyToken(token, '203.0.113.99');
      expect(verifiedWithWrongIp).toBeNull();
    });

    it('rejects bot and headless user agents as GIVT on impression telemetry', () => {
      const bots = [
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'HeadlessChrome/120.0.0.0',
        'curl/7.88.1',
        'python-requests/2.31.0',
        '',
      ];

      for (const ua of bots) {
        const result = fraud.validateImpression({
          placementId: 'p-1',
          serveId: `serve-bot-${Math.random()}`,
          clientIp: '198.51.100.1',
          userAgent: ua,
          eventType: 'impression',
        });

        expect(result.isValid).toBe(false);
        expect(result.ivtCategory).toBe('GIVT');
        expect(result.reasonCode).toBe('BOT_UA');
        expect(result.assessmentStatus).toBe('invalidated');
        expect(result.financialEligibility).toBe('invalid');
      }
    });

    it('rejects sub-threshold, out-of-bounds, or NaN viewability telemetry (MRC bounds)', () => {
      const invalidViewabilityCases = [
        { visibleRatio: 0.49, durationSeconds: 1.5, reason: 'ratio below 0.5' },
        { visibleRatio: -0.1, durationSeconds: 1.5, reason: 'negative ratio' },
        { visibleRatio: 1.01, durationSeconds: 1.5, reason: 'ratio above 1.0' },
        { visibleRatio: 0.75, durationSeconds: 0.95, reason: 'duration below 1.0s display minimum' },
        { visibleRatio: 0.75, durationSeconds: -1, reason: 'negative duration' },
        { visibleRatio: 0.75, durationSeconds: 901, reason: 'duration above 900s timeout' },
        { visibleRatio: NaN, durationSeconds: 1.5, reason: 'NaN ratio' },
        { visibleRatio: 0.75, durationSeconds: NaN, reason: 'NaN duration' },
      ];

      for (const c of invalidViewabilityCases) {
        const res = fraud.validateImpression({
          placementId: 'p-1',
          serveId: `serve-sub-${Math.random()}`,
          clientIp: '198.51.100.2',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          isViewableEvent: true,
          eventType: 'viewable_impression',
          visibleRatio: c.visibleRatio,
          durationSeconds: c.durationSeconds,
          minDurationSeconds: 1,
        });

        expect(res.isValid).toBe(false);
        expect(res.reasonCode).toBe('VIEWABILITY_THRESHOLD');
        expect(res.ivtCategory).toBe('GIVT');
        expect(res.assessmentStatus).toBe('invalidated');
        expect(res.financialEligibility).toBe('invalid');
      }
    });

    it('rejects video viewability duration below 2.0 seconds minimum', () => {
      const res = fraud.validateImpression({
        placementId: 'p-1',
        serveId: 'serve-video-short',
        clientIp: '198.51.100.3',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        isViewableEvent: true,
        eventType: 'viewable_impression',
        visibleRatio: 0.8,
        durationSeconds: 1.8,
        minDurationSeconds: 2, // Video requires >= 2s MRC duration
      });

      expect(res.isValid).toBe(false);
      expect(res.reasonCode).toBe('VIEWABILITY_THRESHOLD');
      expect(res.ivtCategory).toBe('GIVT');
    });

    it('rejects duplicate impression replay as GIVT DUP_IMP', () => {
      const serveId = 'serve-dup-imp-test';
      const first = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.4',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        eventType: 'impression',
      });
      expect(first.isValid).toBe(true);

      const second = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.4',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        eventType: 'impression',
      });
      expect(second.isValid).toBe(false);
      expect(second.reasonCode).toBe('DUP_IMP');
      expect(second.ivtCategory).toBe('GIVT');
      expect(second.assessmentStatus).toBe('invalidated');
    });

    it('rejects duplicate viewable impression replay as GIVT DUP_IMP', () => {
      const serveId = 'serve-dup-view-test';
      const first = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.5',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        eventType: 'viewable_impression',
        visibleRatio: 0.75,
        durationSeconds: 1.2,
      });
      expect(first.isValid).toBe(true);

      const second = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.5',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        eventType: 'viewable_impression',
        visibleRatio: 0.75,
        durationSeconds: 1.2,
      });
      expect(second.isValid).toBe(false);
      expect(second.reasonCode).toBe('DUP_IMP');
    });

    it('ensures render beacon does NOT collide with or block subsequent impression beacon', () => {
      const serveId = 'serve-lifecycle-separation';

      // 1. Render beacon arrives first
      const renderRes = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.6',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        eventType: 'render',
      });
      expect(renderRes.isValid).toBe(true);

      // 2. Impression beacon arrives second -> MUST NOT be flagged as DUP_IMP
      const impRes = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.6',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        eventType: 'impression',
      });
      expect(impRes.isValid).toBe(true);
      expect(impRes.reasonCode).toBeUndefined();

      // 3. Viewable impression beacon arrives third -> MUST NOT be flagged as DUP_IMP
      const viewRes = fraud.validateImpression({
        placementId: 'p-1',
        serveId,
        clientIp: '198.51.100.6',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        eventType: 'viewable_impression',
        visibleRatio: 0.8,
        durationSeconds: 1.1,
      });
      expect(viewRes.isValid).toBe(true);
      expect(viewRes.reasonCode).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. POSITIVE / TELEMETRY DISPATCH & REPORTING PARITY (Asserted Second)
  // =========================================================================

  describe('Positive Delivery Telemetry & Reporting Proof', () => {
    it('generates embed.js with dual render+impression beacons and resilient viewability', () => {
      const service = new DeliveryService({} as any, {} as any, {} as any, {} as any);
      const script = service.getEmbedScript();

      expect(script).toContain('function sendRenderBeacon');
      expect(script).toContain('function sendImpressionBeacon');
      expect(script).toContain('function trackViewability');
      expect(script).toContain('function sendBeaconPost');
      // Verifies removal of restrictive document.hasFocus check that fails in DevTools/iframes
      expect(script).not.toContain('document.hasFocus&&!document.hasFocus()');
      expect(script).toMatch(/type:\s*['"]impression['"]/);
      expect(script).toMatch(/type:\s*['"]render['"]/);
    });

    it('executes client embed in isolated VM, dispatching render, impression, and viewable telemetry', async () => {
      const service = new DeliveryService({} as any, {} as any, {} as any, {} as any);
      const script = service.getEmbedScript();

      const fetchedUrls: Array<{ url: string; options?: any }> = [];
      let intersectionCallback: any = null;

      const slotElement: any = {
        attributes: new Map<string, string>([
          ['data-ad-slot', 'cf-slot-network-plan0065'],
          ['data-cf-api-base', 'https://api.ads.crimfig.com'],
        ]),
        getAttribute(name: string) { return this.attributes.get(name) || null; },
        setAttribute(name: string, val: string) { this.attributes.set(name, val); },
        innerHTML: '',
        children: [] as any[],
        get firstElementChild() { return this.children[0]; },
        style: { minHeight: '', display: '', height: '', padding: '', margin: '' },
        isConnected: true,
        getBoundingClientRect() { return { top: 0, left: 0, bottom: 90, right: 728, width: 728, height: 90 }; },
        appendChild(child: any) { this.children.push(child); },
        querySelectorAll() { return []; },
      };

      const createElement = (tag: string) => ({
        tag,
        isConnected: true,
        style: { cssText: '' },
        textContent: '',
        children: [] as any[],
        attributes: {} as Record<string, string>,
        appendChild(child: any) { this.children.push(child); },
        setAttribute(k: string, v: string) { this.attributes[k] = v; },
        getAttribute(k: string) { return this.attributes[k]; },
        getBoundingClientRect() { return { top: 0, left: 0, bottom: 90, right: 728, width: 728, height: 90 }; },
        addEventListener(event: string, callback: () => void) {
          if (tag === 'img' && event === 'load') Promise.resolve().then(callback);
        },
        removeEventListener() {},
        querySelectorAll() { return []; },
      });

      const sandbox: any = {
        window: {
          location: { hostname: 'staging.crimfig.com' },
          innerHeight: 1000,
          innerWidth: 1000,
          cfPubQ: [],
          IntersectionObserver: function (cb: any) {
            intersectionCallback = cb;
            return { observe: jest.fn(), disconnect: jest.fn() };
          },
          crypto: { randomUUID: () => 'e0000000-0000-4000-8000-000000000001' },
        },
        document: {
          readyState: 'complete',
          visibilityState: 'visible',
          currentScript: { src: 'https://api.ads.crimfig.com/api/v1/delivery/pub-loader.js' },
          querySelectorAll: (sel: string) => sel.includes('crimfig-pub-slot') ? [slotElement] : [],
          getElementById: () => null,
          createElement,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        },
        fetch: jest.fn((url: string, options?: any) => {
          fetchedUrls.push({ url, options });
          if (url.includes('/api/v1/delivery/ad/')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({
                data: {
                  adType: 'image',
                  format: 'banner',
                  headline: 'Plan 0065 Test',
                  imageUrl: '/api/v1/uploads/media/plan0065.jpg',
                  impToken: 'imp_token_plan0065',
                  clickUrl: 'https://staging.crimfig.com',
                  isHouseAd: true,
                },
              }),
            });
          }
          return Promise.resolve({ ok: true });
        }),
        setTimeout: (fn: any, delay: number) => { if (delay < 15000) fn(); return 1; },
        clearTimeout: jest.fn(),
        setInterval: jest.fn(() => 2),
        clearInterval: jest.fn(),
        AbortController,
        Date,
        Math,
        JSON,
        encodeURIComponent,
        MutationObserver: class { observe() {} disconnect() {} },
        Map,
      };
      sandbox.window.document = sandbox.document;
      sandbox.window.fetch = sandbox.fetch;
      sandbox.window.addEventListener = jest.fn();
      sandbox.window.removeEventListener = jest.fn();

      vm.runInNewContext(script, sandbox);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // 1. Ad request was issued
      expect(fetchedUrls.some((f) => f.url.includes('/api/v1/delivery/ad/cf-slot-network-plan0065'))).toBe(true);

      // 2. Both render and impression interaction beacons were dispatched
      const interactionBeacons = fetchedUrls
        .filter((f) => f.url.includes('/api/v1/delivery/interaction'))
        .map((f) => JSON.parse(f.options.body));

      const hasRender = interactionBeacons.some((b) => b.type === 'render');
      const hasImpression = interactionBeacons.some((b) => b.type === 'impression');

      expect(hasRender).toBe(true);
      expect(hasImpression).toBe(true);

      // 3. Trigger IntersectionObserver for MRC viewability (ratio 0.75 >= 0.5)
      expect(typeof intersectionCallback).toBe('function');
      intersectionCallback([{ isIntersecting: true, intersectionRatio: 0.75 }]);

      // 4. Viewability telemetry was dispatched
      const viewabilityBeacons = fetchedUrls
        .filter((f) => f.url.includes('/api/v1/delivery/viewability'))
        .map((f) => JSON.parse(f.options.body));

      expect(viewabilityBeacons.length).toBeGreaterThan(0);
      expect(viewabilityBeacons[0].visibleRatio).toBeGreaterThanOrEqual(0.5);
      expect(viewabilityBeacons[0].durationSeconds).toBeGreaterThanOrEqual(1.0);
    });

    it('calculates performance rates correctly when impressions and viewable impressions are tracked', () => {
      // Prior broken state: serves=4, renders=4, impressions=0, clicks=2 -> CTR was null
      const priorBroken = performanceRates({
        serves: 4,
        renders: 4,
        impressions: 0,
        viewable: 0,
        measurable: 0,
        clicks: 2,
        impressionClicks: 0,
      });
      expect(priorBroken.ctr).toBeNull();
      expect(priorBroken.viewability).toBeNull();

      // Resolved PLAN-0065 state: serves=4, renders=4, impressions=4, viewable=4, measurable=4, clicks=2
      const resolved = performanceRates({
        serves: 4,
        renders: 4,
        impressions: 4,
        viewable: 4,
        measurable: 4,
        clicks: 2,
        impressionClicks: 2,
      });
      expect(resolved.renderRate).toBe(100);
      expect(resolved.ctr).toBe(50.0); // (2 / 4) * 100 = 50% CTR!
      expect(resolved.viewability).toBe(100); // (4 / 4) * 100 = 100% Viewability!
      expect(resolved.clickToServeRate).toBe(50);
      expect(resolved.renderPending).toBe(0);
    });
  });
});
