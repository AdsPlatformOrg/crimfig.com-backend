import { AnalyticsService } from '../../../api/ads-api/src/modules/analytics/analytics.service';
import { PromotersService } from '../../../api/ads-api/src/modules/promoters/promoters.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('Ads Platform Error Hardening & Resilience Invariants (PLAN-0026)', () => {
  describe('AnalyticsService Resilience', () => {
    let analyticsService: AnalyticsService;
    let mockDb: any;
    let mockCampaigns: any[];
    let mockCreatives: any[];
    let mockInteractions: any[];

    beforeEach(() => {
      mockCampaigns = [];
      mockCreatives = [];
      mockInteractions = [];

      const queryChain: any = {
        from: jest.fn(() => queryChain),
        where: jest.fn(() => queryChain),
        innerJoin: jest.fn(() => queryChain),
        groupBy: jest.fn(() => Promise.resolve(mockInteractions)),
        orderBy: jest.fn(() => queryChain),
        limit: jest.fn(() => Promise.resolve(mockCampaigns)),
        then: (resolve: any) => Promise.resolve(mockCampaigns).then(resolve),
      };

      mockDb = {
        select: jest.fn((fields) => {
          if (fields?.status) {
            return {
              from: jest.fn(() => ({
                where: jest.fn(() => Promise.resolve(mockCreatives)),
              })),
            };
          }
          if (fields?.type) {
            return {
              from: jest.fn(() => ({
                innerJoin: jest.fn(() => ({
                  where: jest.fn(() => ({
                    groupBy: jest.fn(() => Promise.resolve(mockInteractions)),
                  })),
                })),
              })),
            };
          }
          // Default select() without fields
          return {
            from: jest.fn((table) => {
              const tableName = String(
                (table as any)?.[Symbol.for('drizzle:Name')] ||
                (table as any)?._?.name ||
                (table as any)?.name ||
                table
              );
              const isCreatives = tableName.includes('creative') || table === require('@crimfig/database/schema').adsCreatives;
              return {
                where: jest.fn(() => Promise.resolve(isCreatives ? mockCreatives : mockCampaigns)),
              };
            }),
            then: (resolve: any) => Promise.resolve(mockCampaigns).then(resolve),
          };
        }),
      };

      analyticsService = new AnalyticsService(mockDb);
    });

    test('getDashboardSummary succeeds with zero campaigns without NaN or exceptions', async () => {
      mockCampaigns = [];
      const summary = await analyticsService.getDashboardSummary('advertiser-user-001');

      expect(summary.campaignCounts.total).toBe(0);
      expect(summary.financials.totalBudgetUsd).toBe(0);
      expect(summary.financials.totalSpentUsd).toBe(0);
      expect(summary.financials.remainingBudgetUsd).toBe(0);
      expect(summary.performance.ctr).toBe(0);
      expect(summary.performance.avgCpmUsd).toBe(0);
      expect(summary.performance.avgCpcUsd).toBe(0);
      expect(Number.isFinite(summary.performance.ctr)).toBe(true);
    });

    test('getDashboardSummary safely handles null/undefined budget fields without producing NaN', async () => {
      mockCampaigns = [
        {
          id: 'camp-1',
          status: 'active',
          budgetUsdCents: null,
          remainingBudgetUsdCents: null,
        },
      ];

      const summary = await analyticsService.getDashboardSummary('advertiser-user-002');
      expect(summary.campaignCounts.total).toBe(1);
      expect(summary.financials.totalBudgetUsd).toBe(0);
      expect(summary.financials.totalSpentUsd).toBe(0);
      expect(summary.performance.avgCpmUsd).toBe(0);
    });

    test('getDashboardAlerts handles null budgets without error', async () => {
      mockCampaigns = [
        {
          id: 'camp-2',
          title: 'Null Budget Campaign',
          status: 'active',
          budgetUsdCents: null,
          remainingBudgetUsdCents: null,
        },
      ];

      const alerts = await analyticsService.getDashboardAlerts('advertiser-user-003');
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0); // Should not falsely trigger low balance on 0/null budget
    });
  });

  describe('PromotersService Resilience', () => {
    let promotersService: PromotersService;
    let mockDb: any;
    let mockUsers: any[];
    let mockPromoters: any[];

    beforeEach(() => {
      mockUsers = [];
      mockPromoters = [];

      mockDb = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              limit: jest.fn(() => Promise.resolve(mockUsers)),
            })),
          })),
        })),
        transaction: jest.fn(async (cb) => {
          const tx: any = {
            execute: jest.fn(() => Promise.resolve()),
            insert: jest.fn(() => ({
              values: jest.fn(() => ({
                onConflictDoNothing: jest.fn(() => Promise.resolve()),
              })),
            })),
            select: jest.fn(() => ({
              from: jest.fn(() => ({
                where: jest.fn(() => ({
                  limit: jest.fn(() => Promise.resolve(mockPromoters)),
                })),
              })),
            })),
          };
          return cb(tx);
        }),
      };

      promotersService = new PromotersService(mockDb);
    });

    test('getOrCreatePromoter throws NotFoundException if user record does not exist in database', async () => {
      mockUsers = []; // User not found
      await expect(
        promotersService.getOrCreatePromoter('non-existent-user-uuid', 'WEBSITE'),
      ).rejects.toThrow(NotFoundException);
    });

    test('getOrCreatePromoter throws BadRequestException if userId is empty', async () => {
      await expect(
        promotersService.getOrCreatePromoter('', 'WEBSITE'),
      ).rejects.toThrow(BadRequestException);
    });

    test('getOrCreatePromoter succeeds when user exists', async () => {
      mockUsers = [{ id: 'valid-user-uuid' }];
      mockPromoters = [{ id: 'promoter-uuid-1', userId: 'valid-user-uuid', type: 'WEBSITE' }];

      const promoter = await promotersService.getOrCreatePromoter('valid-user-uuid', 'WEBSITE');
      expect(promoter.id).toBe('promoter-uuid-1');
      expect(promoter.userId).toBe('valid-user-uuid');
    });
  });
});
