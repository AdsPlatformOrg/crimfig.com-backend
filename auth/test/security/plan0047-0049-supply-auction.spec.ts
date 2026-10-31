import * as vm from 'vm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  normalizePromoterWebsiteInput,
  PromotersService,
} from '../../../api/ads-api/src/modules/promoters/promoters.service';
import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';
import {
  CRIMFIG_HOUSE_CREATIVE,
  DeliveryService,
  domainMatchesRegisteredSite,
  extractHostnameFromHeader,
  HOUSE_CAMPAIGN_UUID,
  HOUSE_CREATIVE_UUID,
} from '../../../api/ads-api/src/modules/delivery/delivery.service';
import {
  AuctionCandidate,
  AuctionEngineService,
} from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';

describe('PLAN-0047 & PLAN-0049 Supply Admission, House/Shadow Ads, Loader & GIVT/SIVT Evidence', () => {
  const ORIGINAL_ENV = process.env.ADS_IMPRESSION_SIGNING_KEY;

  beforeEach(() => {
    process.env.ADS_IMPRESSION_SIGNING_KEY =
      'test_signing_key_32_bytes_minimum_length_2026';
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ADS_IMPRESSION_SIGNING_KEY;
    } else {
      process.env.ADS_IMPRESSION_SIGNING_KEY = ORIGINAL_ENV;
    }
  });

  describe('A01–A03: Promoter Website Onboarding & Domain Normalization', () => {
    it('normalizes HTTPS website root URLs and rejects HTTP, custom ports, credentials, and domain mismatches', () => {
      expect(
        normalizePromoterWebsiteInput('https://www.jed.com.ng', 'jed.com.ng'),
      ).toEqual({
        url: 'https://jed.com.ng/',
        domain: 'jed.com.ng',
      });

      expect(() =>
        normalizePromoterWebsiteInput('http://jed.com.ng', 'jed.com.ng'),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizePromoterWebsiteInput('https://jed.com.ng:8443', 'jed.com.ng'),
      ).toThrow(BadRequestException);
      expect(() =>
        normalizePromoterWebsiteInput('https://other.com', 'jed.com.ng'),
      ).toThrow(BadRequestException);
    });

    it('blocks cross-owner duplicate domain registration while allowing same-owner idempotency', async () => {
      const existingSites = [
        {
          id: 'site-1',
          promoterId: 'promoter-owner-1',
          domain: 'jed.com.ng',
          url: 'https://jed.com.ng/',
          verificationStatus: 'verified',
          isActive: true,
        },
      ];
      const db: any = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(async () => existingSites),
          })),
        })),
      };
      const service = new PromotersService(db);

      await expect(
        service.addWebsite('promoter-attacker-2', {
          url: 'https://jed.com.ng',
          domain: 'jed.com.ng',
          verificationMethod: 'dns_txt',
        }),
      ).rejects.toThrow(ConflictException);

      // Same owner receives existing verified site idempotently
      const sameOwnerResult = await service.addWebsite('promoter-owner-1', {
        url: 'https://jed.com.ng',
        domain: 'jed.com.ng',
        verificationMethod: 'dns_txt',
      });
      expect(sameOwnerResult.id).toBe('site-1');
    });
  });

  describe('A04–A05: Canonical Slot Lifecycle & Suspended Slot Protection', () => {
    it('prevents creating slots on unverified websites and blocks owners from clearing admin slot suspension', async () => {
      let websiteRecord: any = {
        id: 'site-unverified',
        promoterId: 'prom-1',
        domain: 'jed.com.ng',
        verificationStatus: 'pending',
        policyStatus: 'unverified',
        isSuspended: false,
      };
      let slotRecord: any = {
        id: 'slot-suspended',
        promoterId: 'prom-1',
        websiteId: 'site-unverified',
        slotTagId: 'cf-slot-network-aaaa1111',
        lifecycleStatus: 'suspended',
        isActive: false,
      };

      const db: any = {
        select: jest.fn(() => ({
          from: jest.fn((table: any) => ({
            where: jest.fn(() => ({
              limit: jest.fn(async () =>
                table === require('@crimfig/database/schema').adstationSlots
                  ? [slotRecord]
                  : [websiteRecord],
              ),
            })),
          })),
        })),
      };
      const adstation = new AdstationService(db);

      await expect(
        adstation.createSlot('prom-1', {
          websiteId: 'site-unverified',
          name: 'Header Banner',
          slotType: 'network',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        adstation.updateSlot('prom-1', 'slot-suspended', {
          lifecycleStatus: 'active',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('A06–A09 & A19–A20: Supply Admission, Zero-Charge House Ads & Shadow Serving', () => {
    function buildDeliveryService(slotRow: any | null, candidates: any[] = []) {
      const insertedServes: any[] = [];
      const insertedDecisions: any[] = [];
      const insertedInteractions: any[] = [];

      const db: any = {
        select: jest.fn((fields?: any) => ({
          from: jest.fn((table: any) => {
            if (table === require('@crimfig/database/schema').adstationSlots) {
              return {
                innerJoin: jest.fn(() => ({
                  innerJoin: jest.fn(() => ({
                    where: jest.fn(() => ({
                      limit: jest.fn(async () => (slotRow ? [slotRow] : [])),
                    })),
                  })),
                })),
              };
            }
            if (table === require('@crimfig/database/schema').adsServes) {
              return {
                where: jest.fn(() => ({
                  limit: jest.fn(async () => insertedServes),
                })),
              };
            }
            if (
              table === require('@crimfig/database/schema').crimfigGeoTargets
            ) {
              return {
                where: jest.fn(async () => []),
              };
            }
            return {
              innerJoin: jest.fn(() => ({
                innerJoin: jest.fn(() => ({
                  leftJoin: jest.fn(() => ({
                    where: jest.fn(async () => candidates),
                  })),
                })),
              })),
              where: jest.fn(() => ({
                limit: jest.fn(async () => []),
              })),
            };
          }),
        })),
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(async () => []),
          })),
        })),
        insert: jest.fn((table: any) => ({
          values: jest.fn((val: any) => {
            if (table === require('@crimfig/database/schema').adsServes) {
              const row = {
                id: '88888888-8888-4888-8888-888888888888',
                servedAt: new Date(),
                ...val,
              };
              insertedServes.push(row);
              return {
                returning: jest.fn(async () => [row]),
              };
            }
            if (
              table === require('@crimfig/database/schema').adsAuctionDecisions
            ) {
              const row = {
                id: '77777777-7777-4777-8777-777777777777',
                ...val,
              };
              insertedDecisions.push(row);
              return {
                returning: jest.fn(async () => [row]),
              };
            }
            if (table === require('@crimfig/database/schema').adsInteractions) {
              insertedInteractions.push(val);
            }
            return {
              returning: jest.fn(async () => [val]),
            };
          }),
        })),
      };

      const tokenService = new ImpressionTokenService();
      const auctionEngine = new AuctionEngineService();
      const fraudRules = new FraudRulesService();
      const service = new DeliveryService(
        db,
        tokenService,
        auctionEngine,
        fraudRules,
      );
      return {
        service,
        insertedServes,
        insertedDecisions,
        insertedInteractions,
      };
    }

    it('rejects shared catalog slot tokens (cf_slot_0001) and domain mismatches on canonical slots', async () => {
      const slotRow = {
        slot: {
          id: '44444444-4444-4444-8444-444444444444',
          slotTagId: 'cf-slot-network-jed001',
          format: 'banner',
          lifecycleStatus: 'testing',
          isActive: true,
        },
        website: {
          id: '55555555-5555-4555-8555-555555555555',
          domain: 'jed.com.ng',
          verificationStatus: 'verified',
          policyStatus: 'testing',
          isActive: true,
          isSuspended: false,
        },
        promoter: {
          id: '66666666-6666-4666-8666-666666666666',
          isActive: true,
          isSuspended: false,
          trustScore: 80,
        },
      };
      const { service } = buildDeliveryService(slotRow);

      // Shared catalog token rejected
      await expect(
        service.getAdForPlacement(
          'cf_slot_0001',
          '203.0.113.10',
          'Mozilla/5.0 Chrome/120.0',
          'jed.com.ng',
        ),
      ).rejects.toThrow(ForbiddenException);

      // Spoofed / mismatched domain rejected
      await expect(
        service.getAdForPlacement(
          'cf-slot-network-jed001',
          '203.0.113.10',
          'Mozilla/5.0 Chrome/120.0',
          'evil-spoof.example.com',
          undefined,
          undefined,
          undefined,
          { origin: 'https://evil-spoof.example.com' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('an explicit paid flag cannot issue a paid serve on approved active inventory while authority is unavailable',async()=>{
      const previous=process.env.ADS_PAID_SERVING_ENABLED;process.env.ADS_PAID_SERVING_ENABLED='true';
      try {
        const slotRow={slot:{id:'44444444-4444-4444-8444-444444444444',slotTagId:'cf-slot-network-releasegate',format:'banner',lifecycleStatus:'active',isActive:true},
          website:{id:'55555555-5555-4555-8555-555555555555',domain:'jed.com.ng',verificationStatus:'verified',policyStatus:'approved',isActive:true,isSuspended:false},
          promoter:{id:'66666666-6666-4666-8666-666666666666',isActive:true,isSuspended:false,trustScore:90}};
        const {service,insertedServes}=buildDeliveryService(slotRow);
        await service.getAdForPlacement(slotRow.slot.slotTagId,'203.0.113.20','Mozilla/5.0 Chrome/120.0','jed.com.ng',undefined,undefined,{country:'NG'},{origin:'https://jed.com.ng'});
        expect(insertedServes.some(s=>s.inventoryClass==='paid')).toBe(false);
        expect(insertedServes).toHaveLength(1);expect(insertedServes[0]).toMatchObject({inventoryClass:'house',financialEligibility:'invalid',billingPriceNanos:0n});
      } finally {if(previous===undefined)delete process.env.ADS_PAID_SERVING_ENABLED;else process.env.ADS_PAID_SERVING_ENABLED=previous;}
    });

    it('serves a zero-charge CrimFig House Ad on verified testing slots and allows house click redirects without campaign budget', async () => {
      const slotRow = {
        slot: {
          id: '44444444-4444-4444-8444-444444444444',
          slotTagId: 'cf-slot-network-jed001',
          format: 'banner',
          lifecycleStatus: 'testing',
          isActive: true,
        },
        website: {
          id: '55555555-5555-4555-8555-555555555555',
          domain: 'jed.com.ng',
          verificationStatus: 'verified',
          policyStatus: 'testing',
          isActive: true,
          isSuspended: false,
        },
        promoter: {
          id: '66666666-6666-4666-8666-666666666666',
          isActive: true,
          isSuspended: false,
          trustScore: 80,
        },
      };
      const { service, insertedServes, insertedDecisions } =
        buildDeliveryService(slotRow);

      const ad = await service.getAdForPlacement(
        'cf-slot-network-jed001',
        '203.0.113.10',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'jed.com.ng',
        'owned_site_direct', // must be ignored
        false,
        { country: 'NG' },
        { origin: 'https://jed.com.ng' },
      );

      expect(ad.isHouseAd).toBe(true);
      expect(ad.headline).toBe(CRIMFIG_HOUSE_CREATIVE.headline);
      expect(insertedServes).toHaveLength(1);
      expect(insertedServes[0].campaignId).toBe(HOUSE_CAMPAIGN_UUID);
      expect(insertedServes[0].creativeId).toBe(HOUSE_CREATIVE_UUID);
      expect(insertedServes[0].inventoryClass).toBe('house');
      expect(insertedServes[0].billingPriceNanos).toBe(0n);
      expect(insertedServes[0].clearingPriceMicros).toBe(0);
      expect(insertedServes[0].financialEligibility).toBe('invalid');
      expect(insertedDecisions).toHaveLength(1);
      expect(insertedDecisions[0].billingPriceNanos).toBe(0n);

      // Click on House Ad impToken redirects cleanly to CRIMFIG_HOUSE_CREATIVE.destinationUrl without querying campaign budget
      const redirectUrl = await service.handleClick(
        ad.impToken,
        '203.0.113.10',
        'Mozilla/5.0 Chrome/120.0',
        'https://jed.com.ng/',
      );
      expect(redirectUrl).toBe(CRIMFIG_HOUSE_CREATIVE.destinationUrl);
    });

    it('switches to Shadow Serving (zero advertiser charge, zero promoter payout) when traffic risk is high_risk (e.g. headless bot UA)', async () => {
      const approvedSlotRow = {
        slot: {
          id: '44444444-4444-4444-8444-444444444444',
          slotTagId: 'cf-slot-network-jed002',
          format: 'banner',
          lifecycleStatus: 'active',
          isActive: true,
        },
        website: {
          id: '55555555-5555-4555-8555-555555555555',
          domain: 'jed.com.ng',
          verificationStatus: 'verified',
          policyStatus: 'approved',
          isActive: true,
          isSuspended: false,
        },
        promoter: {
          id: '66666666-6666-4666-8666-666666666666',
          isActive: true,
          isSuspended: false,
          trustScore: 85,
        },
      };
      const { service, insertedServes } = buildDeliveryService(approvedSlotRow);

      // Request from HeadlessChrome on an approved active slot -> Shadow served!
      const shadowAd = await service.getAdForPlacement(
        'cf-slot-network-jed002',
        '203.0.113.99',
        'Mozilla/5.0 HeadlessChrome/120.0',
        'jed.com.ng',
        undefined,
        undefined,
        { country: 'NG' },
        { origin: 'https://jed.com.ng' },
      );

      expect(shadowAd.headline).toBe(CRIMFIG_HOUSE_CREATIVE.headline);
      expect(insertedServes).toHaveLength(1);
      expect(insertedServes[0].inventoryClass).toBe('shadow');
      expect(insertedServes[0].deliveryMode).toBe('shadow');
      expect(insertedServes[0].trafficRiskStatus).toBe('high_risk');
      expect(insertedServes[0].billingPriceNanos).toBe(0n);
      expect(insertedServes[0].financialEligibility).toBe('invalid');
    });
  });

  describe('A07: Embed Loader Execution & apiBase Scope Integrity', () => {
    it('executes getEmbedScript() in an isolated VM context without ReferenceError in resolvedMedia or trackViewability', async () => {
      const service = new DeliveryService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const scriptCode = service.getEmbedScript();

      const fetchedUrls: Array<{ url: string; options?: any }> = [];
      let intersectionCallback: any = null;

      const slotElement: any = {
        attributes: new Map<string, string>([
          ['data-ad-slot', 'cf-slot-network-jed001'],
          ['data-cf-api-base', 'https://api.ads.crimfig.com'],
        ]),
        getAttribute(name: string) {
          return this.attributes.get(name) || null;
        },
        setAttribute(name: string, val: string) {
          this.attributes.set(name, val);
        },
        innerHTML: '',
        children: [] as any[],
        appendChild(child: any) {
          this.children.push(child);
        },
      };

      const createElement = (tag: string) => ({
        tag,
        style: { cssText: '' },
        textContent: '',
        children: [] as any[],
        attributes: {} as Record<string, string>,
        appendChild(child: any) {
          this.children.push(child);
        },
        setAttribute(k: string, v: string) {
          this.attributes[k] = v;
        },
        addEventListener() {},
      });

      const sandbox: any = {
        IntersectionObserver: function (cb: any) {
          intersectionCallback = cb;
          return { observe: jest.fn() };
        },
        window: {
          location: { hostname: 'jed.com.ng' },
          cfPubQ: [],
          IntersectionObserver: function (cb: any) {
            intersectionCallback = cb;
            return { observe: jest.fn() };
          },
        },
        document: {
          readyState: 'complete',
          visibilityState: 'visible',
          currentScript: {
            src: 'https://api.ads.crimfig.com/api/v1/delivery/pub-loader.js?pk=test',
          },
          querySelectorAll: (selector: string) => {
            if (selector.indexOf('ins.crimfig-pub-slot') === 0) {
              return slotElement.getAttribute('data-cf-loaded') === 'true'
                ? []
                : [slotElement];
            }
            return [];
          },
          createElement,
          addEventListener: jest.fn(),
        },
        fetch: jest.fn((url: string, options?: any) => {
          fetchedUrls.push({ url, options });
          if (url.includes('/api/v1/delivery/ad/')) {
            return Promise.resolve({
              json: () =>
                Promise.resolve({
                  data: {
                    adType: 'image',
                    format: 'banner',
                    headline: 'CrimFig Test Banner',
                    bodyText: 'Verified supply test',
                    ctaText: 'Learn More',
                    imageUrl: '/api/v1/uploads/media/test-banner.webp',
                    impToken: 'imp_test_token',
                    clickUrl:
                      'https://api.ads.crimfig.com/api/v1/delivery/go/imp_test_token',
                    isHouseAd: true,
                  },
                }),
            });
          }
          return Promise.resolve({ ok: true });
        }),
        setTimeout: (fn: any) => {
          fn();
          return 1;
        },
        clearTimeout: jest.fn(),
        Date,
        Math,
        JSON,
        encodeURIComponent,
        console: { warn: jest.fn() },
      };
      sandbox.window.document = sandbox.document;
      sandbox.window.fetch = sandbox.fetch;

      vm.runInNewContext(scriptCode, sandbox);
      // Wait for Promise microtasks from fetch().then().then()
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Verify ad request + render receipt beacon fired without ReferenceError
      expect(fetchedUrls.some((f) => f.url.includes('/api/v1/delivery/ad/cf-slot-network-jed001'))).toBe(true);
      expect(fetchedUrls.some((f) => f.url.includes('/api/v1/delivery/interaction'))).toBe(true);

      // Trigger IntersectionObserver >= 0.5 to verify trackViewability uses scoped apiBase without ReferenceError
      expect(typeof intersectionCallback).toBe('function');
      intersectionCallback([{ isIntersecting: true, intersectionRatio: 0.75 }]);
      expect(fetchedUrls.some((f) => f.url.includes('/api/v1/delivery/viewability'))).toBe(true);
    });
  });

  describe('A10 & A21: >20 Candidate Auction Evaluation & GIVT/SIVT Classification', () => {
    it('evaluates >20 eligible campaigns deterministically and selects the highest eCPM winner', () => {
      const auction = new AuctionEngineService();
      const candidates: AuctionCandidate[] = [];
      for (let i = 1; i <= 30; i++) {
        candidates.push({
          campaignId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          creativeId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`,
          ownerId: `owner-${i}`,
          status: 'active',
          moderationStatus: 'approved',
          creativeModerationStatus: 'approved',
          headline: `Campaign #${i}`,
          destinationUrl: `https://advertiser-${i}.example.com`,
          pricingModel: 'cpm',
          pricingVersion: 2,
          costPerImpressionUsdCents: 50 + i * 10, // Candidate #30 bids 350 cents ($3.50 CPM)
          costPerClickUsdCents: 10,
          remainingBudgetUsdCents: 5000,
          format: 'banner',
        });
      }

      const result = auction.resolveAuction(candidates, {
        slotHandle: 'cf-slot-network-30',
        requestId: '12121212-1212-4121-8121-121212121212',
      });

      expect(result).not.toBeNull();
      expect(result!.decisionSnapshot.candidateCount).toBe(30);
      expect(result!.decisionSnapshot.eligibleGroupCount).toBe(30);
      expect(result!.winner.campaignId).toBe(
        '00000000-0000-4000-8000-000000000030',
      );
      expect(result!.runnerUp?.campaignId).toBe(
        '00000000-0000-4000-8000-000000000029',
      );
      // Candidate 29 bid 340 cents ($3.40 CPM = 3,400,000 micros) -> clearing price is 3,400,001 micros
      expect(result!.clearingPriceMicros).toBe(3_400_001);
    });

    it('classifies GIVT (bots, duplicate events, sub-threshold viewability) vs SIVT (fast clicks, rate abuse) and computes keyed IP hashes', () => {
      const fraud = new FraudRulesService();

      const hash1 = fraud.computeKeyedIpHash('203.0.113.50');
      expect(hash1.keyedIpHash).toHaveLength(64);
      expect(hash1.keyId).toBeTruthy();

      // GIVT: Bot User-Agent
      const botRes = fraud.validateImpression({
        placementId: 'place-1',
        serveId: 'serve-bot',
        clientIp: '203.0.113.50',
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      });
      expect(botRes.isValid).toBe(false);
      expect(botRes.ivtCategory).toBe('GIVT');
      expect(botRes.financialEligibility).toBe('invalid');

      // GIVT: Sub-threshold viewability (< 0.5 ratio)
      const lowViewRes = fraud.validateImpression({
        placementId: 'place-1',
        serveId: 'serve-low-view',
        clientIp: '203.0.113.51',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        visibleRatio: 0.3,
        durationSeconds: 2,
      });
      expect(lowViewRes.isValid).toBe(false);
      expect(lowViewRes.ivtCategory).toBe('GIVT');
      expect(lowViewRes.reasonCode).toBe('VIEWABILITY_THRESHOLD');

      // Valid viewable impression (>= 0.5 ratio, >= 1s)
      const validView = fraud.validateImpression({
        placementId: 'place-1',
        serveId: 'serve-valid-view',
        clientIp: '203.0.113.52',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        visibleRatio: 0.65,
        durationSeconds: 1.5,
      });
      expect(validView.isValid).toBe(true);
      expect(validView.assessmentStatus).toBe('validated');
      expect(validView.financialEligibility).toBe('eligible');

      // Duplicate (serveId, viewable_impression) replay -> GIVT DUP_IMP
      const dupView = fraud.validateImpression({
        placementId: 'place-1',
        serveId: 'serve-valid-view',
        clientIp: '203.0.113.52',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        isViewableEvent: true,
        visibleRatio: 0.65,
        durationSeconds: 1.5,
      });
      expect(dupView.isValid).toBe(false);
      expect(dupView.ivtCategory).toBe('GIVT');
      expect(dupView.reasonCode).toBe('DUP_IMP');

      // SIVT: Fast click (< 300ms after impression token timestamp)
      const fastClick = fraud.validateClick({
        placementId: 'place-1',
        serveId: 'serve-fast-click',
        clientIp: '203.0.113.53',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        tokenTimestampMs: Date.now() - 50,
      });
      expect(fastClick.isValid).toBe(false);
      expect(fastClick.ivtCategory).toBe('SIVT');
      expect(fastClick.reasonCode).toBe('FAST_CLICK');
    });
  });
});
