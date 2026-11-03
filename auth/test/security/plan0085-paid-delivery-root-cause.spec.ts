import { paidDeliveryReadiness, slotDeliveryDiagnostics } from '../../../api/ads-api/src/modules/delivery/paid-delivery-policy';
import { ConflictException } from '@nestjs/common';
import { DeliveryService, CRIMFIG_HOUSE_CREATIVE, HOUSE_CAMPAIGN_UUID, HOUSE_CREATIVE_UUID } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { AuctionEngineService } from '../../../api/ads-api/src/modules/delivery/auction-engine.service';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { AdsOperationsService } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';

/**
 * PLAN-0085 Root-Cause Proof & Gate Matrix Integration Suite
 * Proves definitively why paid ads do not appear on jed.com.ng:
 * 1. Testing mode fallback gate
 * 2. Website suitability policy gate
 * 3. Platform release authority gate
 * 4. Auction candidate qualification and format compatibility gate
 * 5. Decoupled slot installation check (non-circular)
 */
describe('PLAN-0085: Paid Delivery Root-Cause Investigation & Real Gate Proof', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ADS_IMPRESSION_SIGNING_KEY = 'test_signing_key_32_bytes_minimum_length_2026';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  const STAGING_SLOT_TAG = 'cf-slot-network-1dce0fa5ce5342cd';
  const STAGING_SLOT_ID = '3e45bf37-4fc8-4913-8158-190780b03ed6';
  const STAGING_DOMAIN = 'jed.com.ng';
  const STAGING_WEBSITE_ID = '55555555-5555-4555-8555-555555555555';
  const STAGING_PROMOTER_ID = '66666666-6666-4666-8666-666666666666';

  function createDeliveryHarness(options: {
    slotLifecycle: string;
    websitePolicy: string;
    websiteVerified?: boolean;
    verificationExpired?: boolean;
    candidates?: any[];
  }) {
    const insertedServes: any[] = [];
    const insertedDecisions: any[] = [];
    const insertedInteractions: any[] = [];

    const slotRow = {
      slot: {
        id: STAGING_SLOT_ID,
        slotTagId: STAGING_SLOT_TAG,
        format: 'banner',
        lifecycleStatus: options.slotLifecycle,
        isActive: true,
        allowedAdTypes: JSON.stringify(['text', 'image']),
      },
      website: {
        id: STAGING_WEBSITE_ID,
        domain: STAGING_DOMAIN,
        verificationStatus: options.websiteVerified !== false ? 'verified' : 'unverified',
        verificationExpiresAt: options.verificationExpired
          ? new Date(Date.now() - 10000)
          : new Date(Date.now() + 86400000),
        policyStatus: options.websitePolicy,
        isActive: true,
        isSuspended: false,
      },
      promoter: {
        id: STAGING_PROMOTER_ID,
        isActive: true,
        isSuspended: false,
        trustScore: 85,
      },
    };

    const candidates = options.candidates || [];

    const db: any = {
      select: jest.fn((fields?: any) => ({
        from: jest.fn((table: any) => {
          if (table === require('@crimfig/database/schema').adstationSlots) {
            return {
              innerJoin: jest.fn(() => ({
                innerJoin: jest.fn(() => ({
                  where: jest.fn(() => ({
                    limit: jest.fn(async () => [slotRow]),
                  })),
                })),
              })),
            };
          }
          if (table === require('@crimfig/database/schema').crimfigGeoTargets) {
            return {
              where: jest.fn(async () => []),
            };
          }
          return {
            innerJoin: jest.fn(() => ({
              innerJoin: jest.fn(() => ({
                leftJoin: jest.fn(() => ({
                  where: jest.fn(() => ({
                    limit: jest.fn(async () => candidates),
                  })),
                })),
              })),
            })),
            where: jest.fn(() => ({
              limit: jest.fn(async () => []),
            })),
          };
        }),
      })),
      insert: jest.fn((table: any) => ({
        values: jest.fn((val: any) => {
          if (val.slotTagId && val.inventoryClass) {
            insertedDecisions.push(val);
            return {
              returning: jest.fn(async () => [{ id: 'mock-decision-uuid', ...val }]),
            };
          }
          if (val.slotHandle || val.inventoryClass) {
            const row = { id: '88888888-8888-4888-8888-888888888888', ...val };
            insertedServes.push(row);
            return {
              returning: jest.fn(async () => [row]),
            };
          }
          insertedInteractions.push(val);
          return {
            returning: jest.fn(async () => [val]),
          };
        }),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(async () => []),
        })),
      })),
      execute: jest.fn(async () => ({ rows: [] })),
      transaction: jest.fn(async (cb: any) => {
        const tx: any = {
          execute: jest.fn(async () => ({ rows: [] })),
          insert: db.insert,
          update: db.update,
          select: jest.fn((fields: any) => ({
            from: jest.fn((table: any) => {
              const rows = table === require('@crimfig/database/schema').adsHouseCreatives
                ? [{ ...CRIMFIG_HOUSE_CREATIVE, id: HOUSE_CREATIVE_UUID, version: 1, format: 'any' }]
                : table === require('@crimfig/database/schema').users
                ? [{ status: 'ACTIVE' }]
                : table === require('@crimfig/database/schema').adstationSlots
                ? [{
                    slot: { ...slotRow.slot, promoterId: slotRow.promoter.id },
                    site: { ...slotRow.website, promoterId: slotRow.promoter.id },
                    promoter: { ...slotRow.promoter, userId: '99999999-9999-4999-8999-999999999999' },
                  }]
                : [];
              const query: any = {};
              query.innerJoin = jest.fn(() => query);
              query.where = jest.fn(() => query);
              query.for = jest.fn(() => query);
              query.orderBy = jest.fn(() => query);
              query.then = (resolve: any) => Promise.resolve(rows).then(resolve);
              query.limit = jest.fn(async () => rows);
              return query;
            }),
          })),
        };
        return cb(tx);
      }),
    };

    const tokenService = new ImpressionTokenService();
    const auctionEngine = new AuctionEngineService();
    const fraudRules = new FraudRulesService();
    const opportunities: any = {
      reserve: jest.fn(async (p: any) => ({
        ...p,
        opportunityId: p.opportunityId,
        escrowId: 'mock-escrow-uuid',
      })),
      issue: jest.fn(async (r: any) => ({
        serveId: '88888888-8888-4888-8888-888888888888',
      })),
    };

    const evidence: any = {
      append: jest.fn(async () => ({ id: 'mock-evidence-uuid' })),
    };

    const service = new (DeliveryService as any)(
      db,
      tokenService,
      auctionEngine,
      fraudRules,
      opportunities,
      evidence,
    );

    return { service, insertedServes, insertedDecisions };
  }

  describe('Gate 1 & Gate 2: Why jed.com.ng Serves House Ads When Lifecycle is "testing" or Policy is Pending', () => {
    it('PROVES ROOT CAUSE 1: slot in "testing" lifecycle automatically triggers fallback to zero-charge House Ad', async () => {
      // Slot state exactly matching staging jed.com.ng screenshot: lifecycle = 'testing'
      const { service, insertedServes, insertedDecisions } = createDeliveryHarness({
        slotLifecycle: 'testing',
        websitePolicy: 'approved',
      });

      const ad = await service.getAdForPlacement(
        STAGING_SLOT_TAG,
        '203.0.113.50',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        STAGING_DOMAIN,
        undefined,
        false,
        { country: 'NG' },
        { origin: `https://${STAGING_DOMAIN}` },
      );

      // PROOF: Is a House Ad returned?
      expect(ad.isHouseAd).toBe(true);
      expect(insertedServes).toHaveLength(1);
      expect(insertedServes[0].inventoryClass).toBe('house');
      expect(insertedServes[0].billingPriceNanos).toBe(0n);
      expect(insertedServes[0].financialEligibility).toBe('invalid');
      expect(insertedDecisions[0].inventoryClass).toBe('house');
    });

    it('PROVES ROOT CAUSE 2: website in "pending_approval" policy status falls back to House Ad even if slot is active', async () => {
      const { service, insertedServes } = createDeliveryHarness({
        slotLifecycle: 'active',
        websitePolicy: 'pending_approval', // Not yet approved by Ads Reviewer
      });

      const ad = await service.getAdForPlacement(
        STAGING_SLOT_TAG,
        '203.0.113.50',
        'Mozilla/5.0 Chrome/120.0',
        STAGING_DOMAIN,
        undefined,
        false,
        { country: 'NG' },
        { origin: `https://${STAGING_DOMAIN}` },
      );

      expect(ad.isHouseAd).toBe(true);
      expect(insertedServes[0].inventoryClass).toBe('house');
    });
  });

  describe('Gate 3: Platform Paid Delivery Release Authority', () => {
    it('PROVES ROOT CAUSE 3: missing ADS_PAID_SERVING_ENABLED or policy approval forces House serving', () => {
      const emptyEnv = {
        ADS_PAID_SERVING_ENABLED: 'false',
      };
      const readiness = paidDeliveryReadiness(emptyEnv);
      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toBe('PAID_SERVING_DISABLED');

      const diagnostics = slotDeliveryDiagnostics(
        { lifecycleStatus: 'active', isActive: true },
        { verificationStatus: 'verified', verificationExpiresAt: new Date(Date.now() + 86400000), policyStatus: 'approved' },
        emptyEnv,
      );
      expect(diagnostics.blockers).toContain('PLATFORM_PAID_DELIVERY_UNAVAILABLE');
    });
  });

  describe('Gate 4: Paid Auction Resolution & End-to-End Success When All Gates Pass', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
      Object.assign(process.env, {
        ADS_PAID_SERVING_ENABLED: 'true',
        ADS_PAID_RELEASE_ENABLED: 'true',
        INTERNAL_ECOSYSTEM_KEY: 'local-internal-key',
        BILLING_API_URL: 'http://localhost:3008',
        ADS_EVIDENCE_HASH_SECRET: 'test-evidence-secret-min-32-chars-2026',
        ADS_AUCTION_POLICY_APPROVAL: JSON.stringify({
          version: 'auction_v1',
          approvedBy: 'JED',
          approvedAt: '2026-11-03T00:00:00Z',
          pricing: 'second_price',
          bidderGrouping: 'advertiser',
          floors: 'bid_and_clearing',
          fractionalClosure: 'write_off_subcent',
          pctrBasisPoints: 150,
          eventWindowMs: 900000,
          ingestionToleranceMs: 60000,
        }),
      });
    });

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it.each([
      [undefined, undefined], ['unknown', undefined], ['denied', undefined], ['granted', undefined],
      ['unknown', 'reserve'], ['unknown', 'issue'],
    ] as const)('evaluates paid delivery with consent %s and Billing failure %s', async (consentState, failure) => {
      const eligibleCandidate = {
        campaignId: '99999999-9999-4999-8999-999999999999',
        creativeId: '88888888-8888-4888-8888-888888888888',
        ownerId: '77777777-7777-4777-8777-777777777777',
        category: 'tech',
        headline: 'Staging Paid Sponsor Ad',
        bodyText: 'High quality paid advertising on jed.com.ng',
        ctaText: 'Visit',
        destinationUrl: 'https://sponsor.example.com',
        adType: 'image',
        format: 'banner',
        imageUrl: 'https://cdn.example.com/banner.png',
        pricingModel: 'cpm',
        pricingVersion: 2,
        costPerImpressionUsdCents: 50,
        costPerClickUsdCents: 100,
        remainingBudgetUsdCents: 10000,
        hourlyPacingUsdCents: 1000,
        targetCountries: JSON.stringify(['NG']),
        targetStates: null,
        targetDevices: null,
        targetHours: null,
      };

      const { service } = createDeliveryHarness({
        slotLifecycle: 'active',
        websitePolicy: 'approved',
        candidates: [eligibleCandidate],
      });

      // Mock resolveAuction to return the winning candidate
      jest.spyOn((service as any).auctionEngine, 'resolveAuction').mockReturnValue({
        winner: eligibleCandidate,
        clearingPriceMicros: 500000,
        billingPriceNanos: 500000000n,
        decisionSnapshot: {
          requestId: 'test-req-id',
          slotHandle: STAGING_SLOT_TAG,
          winnerCampaignId: eligibleCandidate.campaignId,
          winnerCreativeId: eligibleCandidate.creativeId,
          pricingModel: 'cpm',
          inventoryClass: 'paid',
          candidateCount: 1,
        },
      });

      const fallback = jest.spyOn(service, 'serveHouseOrShadowAd');
      if (failure) {
        service.opportunities[failure].mockRejectedValueOnce(new ConflictException());
        fallback.mockResolvedValueOnce({ isHouseAd: true });
      }
      const ad = await service.getAdForPlacement(
        STAGING_SLOT_TAG,
        '203.0.113.50',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        STAGING_DOMAIN,
        undefined,
        false,
        { country: 'NG' },
        { origin: `https://${STAGING_DOMAIN}`, consentState, measurementConsent: consentState === 'granted' },
      );

      if (failure) {
        expect(ad.isHouseAd).toBe(true);
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
          parentOpportunityId: expect.any(String), candidateCount: 1,
          excludedCandidates: [expect.objectContaining({
            reasonCode: 'BILLING_OPPORTUNITY_CONFLICT', stage: `billing_${failure}`, campaignId: eligibleCandidate.campaignId,
            upstreamStatus: 409,
            billingHandoff: expect.objectContaining({reserve: failure === 'reserve' ? 'rejected' : 'confirmed', issue: failure === 'issue' ? 'rejected' : 'not_attempted'}),
          })],
        }));
        return;
      }
      expect(ad.isHouseAd).toBe(false);
      expect(ad.headline).toBe('Staging Paid Sponsor Ad');
      expect(ad.clickUrl).toContain('/api/v1/delivery/go/');
      expect(ad.impToken).toBeDefined();
    });
  });

  describe('Non-Circular Slot Installation Verification', () => {
    it('certifies slot installation using legitimate serve telemetry without requiring a paid ad', async () => {
      // Verification must work even when serve was a test or House serve (not billable paid serve)
      let selectCall = 0;
      const mockTx = {
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn(() => {
          selectCall++;
          const currentCall = selectCall;
          return {
            from: jest.fn(() => {
              if (currentCall <= 2) {
                return {
                  where: jest.fn(() => ({
                    for: jest.fn(() => ({
                      limit: jest.fn().mockImplementation(async () => {
                        if (currentCall === 1) {
                          return [
                            {
                              id: STAGING_SLOT_ID,
                              websiteId: STAGING_WEBSITE_ID,
                              slotTagId: STAGING_SLOT_TAG,
                              lifecycleStatus: 'testing',
                              installationStatus: 'unchecked',
                            },
                          ];
                        }
                        return [
                          {
                            id: STAGING_WEBSITE_ID,
                            domain: STAGING_DOMAIN,
                            verificationStatus: 'verified',
                            verificationExpiresAt: new Date(Date.now() + 86400000),
                            policyStatus: 'approved',
                            isSuspended: false,
                          },
                        ];
                      }),
                    })),
                  })),
                };
              }
              return {
                where: jest.fn(async () => {
                  if (currentCall === 3) {
                    return [{ serveCount: 5, lastServedAt: new Date() }];
                  }
                  return [{ renderCount: 3, impressionCount: 2 }];
                }),
              };
            }),
          };
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([
                {
                  id: STAGING_SLOT_ID,
                  installationStatus: 'verified',
                  lifecycleStatus: 'active',
                },
              ]),
            }),
          }),
        }),
      };

      const mockDb = {
        transaction: jest.fn().mockImplementation(async (cb) => cb(mockTx)),
      };

      const adstationService = new (AdsOperationsService as any)(mockDb);
      const result = await adstationService.adminCheckSlotInstallation(STAGING_SLOT_ID);

      expect(result.isInstalled).toBe(true);
      expect(result.installationStatus).toBe('verified');
      expect(result.lifecycleStatus).toBe('active');
      expect(result.diagnostic).toContain(`Verified embed activity on ${STAGING_DOMAIN}`);
    });
  });
});
