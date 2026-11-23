import { BadRequestException } from '@nestjs/common';
import { ADS_ROLES_KEY } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { AdminPlatformMetricsController } from '../../../api/ads-api/src/modules/ecosystem/admin-platform-metrics.controller';
import {
  AdminPlatformMetricsService,
  parseMetricsWindowDays,
} from '../../../api/ads-api/src/modules/ecosystem/admin-platform-metrics.service';

describe('AdminPlatformMetricsService & Controller (PLAN-0160)', () => {
  it('rejects unsupported window day queries before touching the database', async () => {
    const db = { execute: jest.fn() };
    const service = new AdminPlatformMetricsService(db as any);

    await expect(service.getOverview('365')).rejects.toThrow(BadRequestException);
    await expect(service.getOverview('-7')).rejects.toThrow(BadRequestException);
    await expect(service.getOverview('abc')).rejects.toThrow(BadRequestException);
    expect(() => parseMetricsWindowDays('15')).toThrow(BadRequestException);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('requires staff @AdsRoles on AdminPlatformMetricsController and refuses silent error suppression', async () => {
    const roles = Reflect.getMetadata(
      ADS_ROLES_KEY,
      AdminPlatformMetricsController.prototype.overview,
    );
    expect(roles).toEqual(
      expect.arrayContaining([
        'super_admin',
        'ads_admin',
        'ads_finance',
        'ads_support',
        'report_auditor',
      ]),
    );

    const db = { execute: jest.fn().mockRejectedValue(new Error('db unavailable')) };
    const service = new AdminPlatformMetricsService(db as any);
    await expect(service.getOverview('30')).rejects.toThrow('db unavailable');
  });

  it('preserves genuine zeros and computes clamped 0% dial rates without NaN', async () => {
    const db = {
      execute: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const service = new AdminPlatformMetricsService(db as any);

    const overview = await service.getOverview();
    expect(overview.windowDays).toBe(30);
    expect(overview.users.totalSignedUp).toBe(0);
    expect(overview.websites.setup).toBe(0);
    expect(overview.adSlots.created).toBe(0);
    expect(overview.rates).toEqual({
      userVerificationPct: 0,
      websiteVerificationPct: 0,
      websiteSlotCoveragePct: 0,
      websiteEmbedInstallPct: 0,
      slotInstallPct: 0,
    });
    expect(overview.dailySeries).toEqual([]);
  });

  it('returns accurate aggregated counts, funnel percentages, slot type mix, and daily points', async () => {
    const db = {
      execute: jest
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              total_signed_up: 120,
              email_verified: 96,
              active_accounts: 94,
              pending_verification: 24,
              suspended: 2,
              new_in_window: 18,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              total_promoters: 40,
              setup: 50,
              verified: 35,
              pending_verification: 10,
              failed_verification: 5,
              policy_approved: 28,
              with_slots_created: 30,
              with_slots_added: 22,
              pinging_7d: 19,
              new_in_window: 9,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              created: 64,
              added_verified: 40,
              live_active: 36,
              pending_install: 24,
              retired: 3,
              new_in_window: 12,
              type_consideration: 30,
              type_network: 20,
              type_direct: 10,
              type_hybrid: 4,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              advertisers_with_campaigns: 14,
              total: 25,
              active: 11,
              under_review: 3,
              draft: 6,
              paused: 5,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ paid_serves: 1500, house_serves: 420 }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              date: '2026-11-22',
              users_signed_up: 4,
              websites_setup: 2,
              websites_verified: 1,
              slots_created: 3,
              slots_added: 2,
            },
            {
              date: '2026-11-23',
              users_signed_up: 6,
              websites_setup: 3,
              websites_verified: 2,
              slots_created: 4,
              slots_added: 3,
            },
          ],
        }),
    };

    const controller = new AdminPlatformMetricsController(
      new AdminPlatformMetricsService(db as any),
    );
    const result = await controller.overview('7');

    expect(result.status).toBe('success');
    expect(result.data.windowDays).toBe(7);
    expect(result.data.users).toEqual({
      totalSignedUp: 120,
      emailVerified: 96,
      activeAccounts: 94,
      pendingVerification: 24,
      suspended: 2,
      newInWindow: 18,
    });
    expect(result.data.websites).toEqual({
      totalPromoters: 40,
      setup: 50,
      verified: 35,
      pendingVerification: 10,
      failedVerification: 5,
      policyApproved: 28,
      withSlotsCreated: 30,
      withSlotsAdded: 22,
      pinging7d: 19,
      newInWindow: 9,
    });
    expect(result.data.adSlots.byType).toEqual({
      consideration: 30,
      network: 20,
      direct: 10,
      hybrid: 4,
    });
    expect(result.data.rates).toEqual({
      userVerificationPct: 80,
      websiteVerificationPct: 70,
      websiteSlotCoveragePct: 60,
      websiteEmbedInstallPct: 44,
      slotInstallPct: 62.5,
    });
    expect(result.data.dailySeries).toHaveLength(2);
    expect(result.data.dailySeries[1]).toEqual({
      date: '2026-11-23',
      usersSignedUp: 6,
      websitesSetup: 3,
      websitesVerified: 2,
      slotsCreated: 4,
      slotsAdded: 3,
    });
  });
});
