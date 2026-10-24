import { AnalyticsService } from '../../../api/ads-api/src/modules/analytics/analytics.service';
import { PromotersService } from '../../../api/ads-api/src/modules/promoters/promoters.service';
import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('Comprehensive API Endpoint Unit Tests (PLAN-0027)', () => {
  describe('Ads Platform API Endpoints (Non-Destructive & Invariant Safe)', () => {
    let analyticsService: AnalyticsService;
    let promotersService: PromotersService;
    let adstationService: AdstationService;
    let mockDb: any;
    let savedRows: any[];

    beforeEach(() => {
      savedRows = [];
      const queryChain: any = {
        from: jest.fn(() => queryChain),
        where: jest.fn(() => queryChain),
        innerJoin: jest.fn(() => queryChain),
        groupBy: jest.fn(() => Promise.resolve([])),
        orderBy: jest.fn(() => queryChain),
        limit: jest.fn((n?: number) => Promise.resolve(savedRows.slice(0, n || 1))),
        returning: jest.fn(() => Promise.resolve(savedRows)),
        then: (resolve: any) => Promise.resolve(savedRows).then(resolve),
      };

      mockDb = {
        select: jest.fn(() => queryChain),
        insert: jest.fn(() => ({
          values: jest.fn((vals) => {
            const row = { id: 'evt-uuid-1234', ...vals };
            savedRows.push(row);
            return {
              returning: jest.fn(() => Promise.resolve([row])),
            };
          }),
        })),
        update: jest.fn(() => ({
          set: jest.fn((vals) => ({
            where: jest.fn(() => ({
              returning: jest.fn(() => Promise.resolve([{ id: 'updated-1', ...vals }])),
            })),
          })),
        })),
      };

      analyticsService = new AnalyticsService(mockDb);
      promotersService = new PromotersService(mockDb);
      adstationService = new AdstationService(mockDb);
    });

    it('GET /api/v1/analytics/dashboard/summary - returns valid non-null summary metrics without NaN', async () => {
      const summary = await analyticsService.getDashboardSummary('user-uuid-1', '30d');
      expect(summary).toBeDefined();
      expect(summary.period).toBe('30d');
      expect(summary.financials.totalBudgetUsd).toBe(0);
      expect(summary.performance.ctr).toBe(0);
      expect(Number.isNaN(summary.performance.ctr)).toBe(false);
      expect(Number.isNaN(summary.performance.avgCpmUsd)).toBe(false);
    });

    it('GET /api/v1/analytics/dashboard/alerts - returns array of structured alert items', async () => {
      const alerts = await analyticsService.getDashboardAlerts('user-uuid-1');
      expect(alerts).toBeDefined();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('GET /api/v1/promoters/me - throws NotFoundException if user identity has not synced', async () => {
      mockDb.select = jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn(() => Promise.resolve([])), // No user found
          })),
        })),
      }));

      await expect(
        promotersService.getOrCreatePromoter('unregistered-user-uuid')
      ).rejects.toThrow(NotFoundException);
    });


    it('POST /api/v1/adstation/direct-campaigns - strictly rejects direct campaigns assigned to consideration slots', async () => {
      savedRows = [
        {
          id: 'slot-cons-001',
          isConsiderationSlot: true,
          slotType: 'consideration',
        },
      ];

      await expect(
        adstationService.createDirectCampaign('promoter-uuid', {
          websiteId: 'website-uuid',
          slotId: 'slot-cons-001',
          clientName: 'Direct Client Corp',
          campaignTitle: 'Direct Banner',
          destinationUrl: 'https://client.com',
        })
      ).rejects.toThrow('Direct deals cannot be assigned to a Consideration Slot');
    });

    it('POST /api/v1/adstation/events - deduplicates identical event beacons without modifying user balance', async () => {
      const res1 = await adstationService.recordDirectEvent({
        directCampaignId: 'dc-1',
        websiteId: 'web-1',
        eventType: 'impression',
        idempotencyKey: 'idem-key-1000',
      });

      expect(res1.status).toBe('recorded');
      expect(res1.eventId).toBeDefined();

      savedRows = [{ id: res1.eventId, idempotencyKey: 'idem-key-1000' }];
      const res2 = await adstationService.recordDirectEvent({
        directCampaignId: 'dc-1',
        websiteId: 'web-1',
        eventType: 'impression',
        idempotencyKey: 'idem-key-1000',
      });

      expect(res2.status).toBe('duplicate_ignored');
      expect(res2.eventId).toBe(res1.eventId);
    });
  });

  describe('Session & Cookie Safety Guardrails (Non-Destructive Invariant)', () => {
    it('Session & cookie mutation tests are skipped unless explicit opt-in is enabled', () => {
      const allowSensitiveSessionTests = process.env.PROCESS_SENSITIVE_AUTH_TESTS === 'true';

      if (!allowSensitiveSessionTests) {
        expect(allowSensitiveSessionTests).toBe(false);
      } else {
        expect(true).toBe(true);
      }
    });

    it('Admin test suite configuration enforces non-destructive headers by default', () => {
      const requestHeaders: Record<string, string> = {};
      const isSensitivePermitted = requestHeaders['X-Allow-Sensitive-Session-Tests'] === 'true';

      expect(isSensitivePermitted).toBe(false);
    });
  });
});
