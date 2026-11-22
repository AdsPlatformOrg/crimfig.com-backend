import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { BadRequestException, ForbiddenException, Get } from '@nestjs/common';
import {
  evaluateDirectSlotReadiness,
  isWebsiteNetworkOperational,
} from '../../../api/ads-api/src/modules/adstation/adstation-gating';
import { PublisherSlotsService } from '../../../api/ads-api/src/modules/publisher-inventory/publisher-slots.service';
import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';
import { AdsOperationsService } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';
import { AdsOperationsController } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.controller';
import { documentAdsController } from '../../../api/ads-api/src/contracts/ads-contract';
import { AnalyticsService } from '../../../api/ads-api/src/modules/analytics/analytics.service';

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

function makeWebsite(overrides: Record<string, any> = {}) {
  return {
    id: 'site-1',
    isActive: true,
    isSuspended: false,
    verificationStatus: 'verified',
    verificationExpiresAt: futureDate,
    policyStatus: 'approved',
    ...overrides,
  };
}

function makeNetworkSlot(overrides: Record<string, any> = {}) {
  return {
    id: 'net-slot-1',
    websiteId: 'site-1',
    slotType: 'network',
    lifecycleStatus: 'active',
    isActive: true,
    installationStatus: 'verified',
    isConsiderationVerified: false,
    ...overrides,
  };
}

function makeDirectSlot(overrides: Record<string, any> = {}) {
  return {
    id: 'direct-slot-1',
    websiteId: 'site-1',
    slotType: 'direct',
    lifecycleStatus: 'testing',
    isActive: true,
    policyRevision: 1,
    manualReviewStatus: 'pending_review',
    approvedRevision: null as number | null,
    reviewReason: null as string | null,
    ...overrides,
  };
}

describe('PLAN-0115: AdStation Direct Ad Slot Mandatory Dual LIVE Gating', () => {
  describe('Negative / Rejection Cases First', () => {
    it('rejects LIVE eligibility when CrimFig Ad Network is not active on the same website even if manually approved', () => {
      const website = makeWebsite();
      const slot = makeDirectSlot({
        manualReviewStatus: 'approved',
        approvedRevision: 1,
        policyRevision: 1,
      });

      const readiness = evaluateDirectSlotReadiness(slot, website, []);
      expect(readiness.networkActiveOnWebsite).toBe(false);
      expect(readiness.manualReviewApprovedOnCurrentRevision).toBe(true);
      expect(readiness.liveEligible).toBe(false);
      expect(readiness.displayStatus).toBe('Approved — Network Not Active');
      expect(readiness.blockerReasons.length).toBeGreaterThan(0);
    });

    it('rejects LIVE eligibility when CrimFig Ad Network is active only on a DIFFERENT website', () => {
      const website = makeWebsite({ id: 'site-1' });
      const otherSiteNetworkSlot = makeNetworkSlot({ websiteId: 'site-2' });
      const directSlot = makeDirectSlot({
        websiteId: 'site-1',
        manualReviewStatus: 'approved',
        approvedRevision: 1,
      });

      expect(isWebsiteNetworkOperational(website, [otherSiteNetworkSlot])).toBe(false);
      const readiness = evaluateDirectSlotReadiness(directSlot, website, [otherSiteNetworkSlot]);
      expect(readiness.liveEligible).toBe(false);
      expect(readiness.displayStatus).toBe('Approved — Network Not Active');
    });

    it('rejects LIVE eligibility when manual review is pending or rejected even if Ad Network is active', () => {
      const website = makeWebsite();
      const netSlot = makeNetworkSlot();

      const pendingReadiness = evaluateDirectSlotReadiness(
        makeDirectSlot({ manualReviewStatus: 'pending_review', approvedRevision: null }),
        website,
        [netSlot],
      );
      expect(pendingReadiness.liveEligible).toBe(false);
      expect(pendingReadiness.displayStatus).toBe('Published — Pending Review');

      const rejectedReadiness = evaluateDirectSlotReadiness(
        makeDirectSlot({
          manualReviewStatus: 'rejected',
          approvedRevision: null,
          reviewReason: 'Prohibited creative layout',
        }),
        website,
        [netSlot],
      );
      expect(rejectedReadiness.liveEligible).toBe(false);
      expect(rejectedReadiness.displayStatus).toBe('Rejected');
      expect(rejectedReadiness.blockerReasons.join(' ')).toContain('Prohibited creative layout');
    });

    it('invalidates prior approval when material revision advances beyond approvedRevision', () => {
      const website = makeWebsite();
      const netSlot = makeNetworkSlot();
      const editedSlot = makeDirectSlot({
        policyRevision: 2,
        manualReviewStatus: 'approved',
        approvedRevision: 1,
      });

      const readiness = evaluateDirectSlotReadiness(editedSlot, website, [netSlot]);
      expect(readiness.manualReviewApprovedOnCurrentRevision).toBe(false);
      expect(readiness.liveEligible).toBe(false);
      expect(readiness.displayStatus).toBe('Published — Pending Review');
    });

    it('blocks PublisherSlotsService.updateSlot from transitioning a direct slot to active without dual gating', async () => {
      const slotRow = {
        id: 'direct-slot-1',
        promoterId: 'prom-1',
        websiteId: 'site-1',
        name: 'Header Direct',
        slotType: 'direct',
        format: 'banner',
        slotDeliveryPreference: null,
        width: 728,
        height: 90,
        responsive: true,
        lifecycleStatus: 'testing',
        isActive: true,
        policyRevision: 1,
        manualReviewStatus: 'pending_review',
        approvedRevision: null,
        installationStatus: 'unchecked',
        isConsiderationVerified: false,
      };
      const websiteRow = makeWebsite();
      const netSlot = makeNetworkSlot();

      let updateCalled = false;
      const selectQueue: any[] = [[slotRow], [websiteRow], [netSlot]];
      const txMock: any = {
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => {
              const next = selectQueue.shift() ?? [];
              return {
                for: jest.fn(() => ({ limit: jest.fn().mockResolvedValue(next) })),
                limit: jest.fn().mockResolvedValue(next),
                then: (resolve: any) => resolve(next),
              };
            }),
          })),
        })),
        update: jest.fn(() => {
          updateCalled = true;
          return { set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })) };
        }),
        insert: jest.fn(),
      };
      const dbMock: any = { transaction: jest.fn(async (fn: any) => fn(txMock)) };
      const svc = new PublisherSlotsService(dbMock);

      await expect(
        svc.updateSlot('prom-1', 'direct-slot-1', { lifecycleStatus: 'active' }),
      ).rejects.toThrow(ForbiddenException);
      expect(updateCalled).toBe(false);
    });

    it('blocks AdstationService.recordDirectEvent when the bound direct slot is not Live / eligible', async () => {
      const campaignRow = { id: 'dc-1', promoterId: 'prom-1', websiteId: 'site-1' };
      const slotRow = makeDirectSlot({
        lifecycleStatus: 'testing',
        manualReviewStatus: 'pending_review',
      });
      const websiteRow = makeWebsite();
      const selectQueue: any[] = [[campaignRow], [slotRow], [websiteRow], []];
      let insertCalled = false;

      const dbMock: any = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => {
              const next = selectQueue.shift() ?? [];
              return {
                limit: jest.fn().mockResolvedValue(next),
                then: (resolve: any) => resolve(next),
              };
            }),
          })),
        })),
        insert: jest.fn(() => {
          insertCalled = true;
          return { values: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) };
        }),
      };

      const svc = new AdstationService(dbMock);
      await expect(
        svc.recordDirectEvent({
          promoterId: 'prom-1',
          directCampaignId: 'dc-1',
          websiteId: 'site-1',
          slotId: 'direct-slot-1',
          eventType: 'impression',
          idempotencyKey: 'idem-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(insertCalled).toBe(false);
    });

    it('rejects AdsOperationsService.adminReviewDirectSlot when reason is missing/short', async () => {
      const svc = new AdsOperationsService({ transaction: jest.fn() } as any);
      await expect(
        svc.adminReviewDirectSlot('direct-slot-1', 'approved', 'ok', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Positive Cases', () => {
    it('allows LIVE eligibility when same-website Ad Network is operational (even with 0 paid impressions) AND current revision is approved', () => {
      const website = makeWebsite();
      const netSlot = makeNetworkSlot({ slotType: 'consideration', isConsiderationVerified: true, installationStatus: 'unchecked' });
      const directSlot = makeDirectSlot({
        lifecycleStatus: 'active',
        manualReviewStatus: 'approved',
        approvedRevision: 3,
        policyRevision: 3,
      });

      const readiness = evaluateDirectSlotReadiness(directSlot, website, [netSlot]);
      expect(readiness.networkActiveOnWebsite).toBe(true);
      expect(readiness.manualReviewApprovedOnCurrentRevision).toBe(true);
      expect(readiness.liveEligible).toBe(true);
      expect(readiness.displayStatus).toBe('Live');
      expect(readiness.blockerReasons).toEqual([]);
    });

    it('AnalyticsService.getDashboardSummary uses authoritative net settled spend and separates validClicks from observed clicks', async () => {
      const campaigns = [{ id: 'camp-1', status: 'active', budgetUsdCents: 5000, remainingBudgetUsdCents: 4930 }];
      const creatives = [{ status: 'approved' }];
      const interactionCounts = [
        { type: 'impression', count: 36 },
        { type: 'click', count: 7 },
      ];
      const spendRow = [{ grossSpendCents: 120, reversalCents: 50 }];
      const selectQueue = [campaigns, creatives, interactionCounts, spendRow];

      const dbMock: any = {
        select: jest.fn(() => ({
          from: jest.fn(() => {
            const next = selectQueue.shift() ?? [];
            const chain: any = {
              leftJoin: jest.fn(() => chain),
              where: jest.fn(() => chain),
              groupBy: jest.fn(() => Promise.resolve(next)),
              then: (resolve: any) => resolve(next),
            };
            return chain;
          }),
        })),
        execute: jest.fn().mockResolvedValue({
          rows: [{ day: '2026-11-15', source: 'embed', observed: 13, billed: 7 }],
        }),
      };

      const svc = new AnalyticsService(dbMock);
      const summary = await svc.getDashboardSummary('adv-1', '30d');
      expect(summary.financials.netSettledSpendUsd).toBe(0.7);
      expect(summary.performance.impressions).toBe(36);
      expect(summary.performance.validClicks).toBe(7);
      expect(summary.performance.clicks).toBe(13);
      expect(summary.performance.billedClicks).toBe(7);
    });

    it('AdsOperationsController loads and passes documentAdsController contract registration (including adminReviewDirectSlot)', () => {
      class UncontractedController {
        @Get('undocumented')
        undocumentedMethod() {}
      }
      expect(() => documentAdsController(UncontractedController)).toThrow(
        /Missing API response contract/,
      );
      expect(() => documentAdsController(AdsOperationsController)).not.toThrow();
    });
  });
});


test('PLAN0136 a Live Direct slot cannot fall into the Network auction or House fallback', async () => {
  const slot = makeDirectSlot({
    lifecycleStatus: 'active', manualReviewStatus: 'approved', approvedRevision: 1,
  });
  const website = makeWebsite({ domain: 'publisher.example.test' });
  const rows = [{ slot, website, promoter: { isActive: true, isSuspended: false } }];
  const db = {
    select: jest.fn()
      .mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ innerJoin: () => ({
        where: () => ({ limit: async () => rows }),
      }) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: async () => [makeNetworkSlot()] }) }),
    update: jest.fn(),
    transaction: jest.fn(),
  };
  const auction = { runAuction: jest.fn() };
  const delivery = new DeliveryService(db as any, { assertConfigured: jest.fn() } as any, auction as any, {} as any);
  await expect(delivery.getAdForPlacement('cf-slot-direct-fixture', undefined, undefined, 'publisher.example.test'))
    .resolves.toBeNull();
  expect(auction.runAuction).not.toHaveBeenCalled();
  expect(db.update).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
});
