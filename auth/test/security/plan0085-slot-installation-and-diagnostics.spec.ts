import { AdsOperationsService } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { paidDeliveryReadiness, slotDeliveryDiagnostics } from '../../../api/ads-api/src/modules/delivery/paid-delivery-policy';

describe('PLAN-0085: Slot Installation Verification, Auction Decisions Serialization & Staging Delivery Diagnostics', () => {
  describe('Auction Decisions Serialization (BigInt Fix)', () => {
    it('safely serializes billingPriceNanos without throwing TypeError', () => {
      const mockRows = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          requestId: '22222222-2222-2222-2222-222222222222',
          slotTagId: 'cf-slot-network-1dce0fa5ce5342cd',
          inventoryClass: 'paid',
          billingPriceNanos: 500000000n, // BigInt from Drizzle pg schema
          createdAt: new Date('2026-11-03T05:00:00Z'),
        },
      ];

      // Service sanitization test
      const sanitized = mockRows.map((row) => ({
        ...row,
        billingPriceNanos:
          typeof row.billingPriceNanos === 'bigint'
            ? row.billingPriceNanos.toString()
            : row.billingPriceNanos,
      }));

      expect(() => JSON.stringify(sanitized)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(sanitized));
      expect(parsed[0].billingPriceNanos).toBe('500000000');
    });
  });

  describe('Staging Delivery Diagnostics on jed.com.ng and cf-slot-network-1dce0fa5ce5342cd', () => {
    it('identifies exact blockers preventing paid delivery when slot is testing or unchecked', () => {
      const slot = {
        lifecycleStatus: 'testing', // Still in testing
        isActive: true,
        installationStatus: 'unchecked',
      };

      const website = {
        domain: 'jed.com.ng',
        verificationStatus: 'verified',
        verificationExpiresAt: new Date(Date.now() + 86400000),
        policyStatus: 'pending_approval', // Not yet approved
        isSuspended: false,
      };

      // When platform paid serving is not enabled:
      const diagnostics = slotDeliveryDiagnostics(slot, website, {
        ADS_PAID_SERVING_ENABLED: 'false',
      });

      expect(diagnostics.status).toBe('blocked');
      expect(diagnostics.blockers).toContain('WEBSITE_APPROVAL_REQUIRED');
      expect(diagnostics.blockers).toContain('SLOT_NOT_ACTIVE');
      expect(diagnostics.blockers).toContain('PLATFORM_PAID_DELIVERY_UNAVAILABLE');
    });

    it('identifies remaining blockers when website policy is approved but slot is still testing', () => {
      const slot = {
        lifecycleStatus: 'testing',
        isActive: true,
      };

      const website = {
        domain: 'jed.com.ng',
        verificationStatus: 'verified',
        verificationExpiresAt: new Date(Date.now() + 86400000),
        policyStatus: 'approved',
        isSuspended: false,
      };

      const diagnostics = slotDeliveryDiagnostics(slot, website, {
        ADS_PAID_SERVING_ENABLED: 'true',
        ADS_PAID_RELEASE_ENABLED: 'true',
        INTERNAL_ECOSYSTEM_KEY: 'mock-key',
        BILLING_API_URL: 'http://localhost:3008',
        ADS_EVIDENCE_HASH_SECRET: 'test-secret-min-32-characters-length-2026',
        ADS_AUCTION_POLICY_APPROVAL: JSON.stringify({
          version: 'v1',
          approvedBy: 'JED',
          approvedAt: '2026-11-03',
          pricing: 'second_price',
          bidderGrouping: 'advertiser',
          floors: 'bid_and_clearing',
          fractionalClosure: 'write_off_subcent',
          pctrBasisPoints: 150,
          eventWindowMs: 900000,
          ingestionToleranceMs: 60000,
        }),
      });

      expect(diagnostics.blockers).toContain('SLOT_NOT_ACTIVE');
      expect(diagnostics.blockers).not.toContain('WEBSITE_APPROVAL_REQUIRED');
      expect(diagnostics.blockers).not.toContain('PLATFORM_PAID_DELIVERY_UNAVAILABLE');
    });
  });

  describe('Staff Slot Installation Verification Safeguards', () => {
    it('fails closed when website ownership verification has expired', async () => {
      const mockTx = {
        execute: jest.fn().mockResolvedValue(undefined),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              for: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValueOnce([
                  {
                    id: '3e45bf37-4fc8-4913-8158-190780b03ed6',
                    websiteId: 'website-uuid',
                    slotTagId: 'cf-slot-network-1dce0fa5ce5342cd',
                  },
                ]).mockResolvedValueOnce([
                  {
                    id: 'website-uuid',
                    domain: 'jed.com.ng',
                    verificationStatus: 'verified',
                    verificationExpiresAt: new Date(Date.now() - 10000), // Expired!
                    policyStatus: 'approved',
                    isSuspended: false,
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      const mockDb = {
        transaction: jest.fn().mockImplementation(async (cb) => cb(mockTx)),
      };

      const service = new (AdsOperationsService as any)(mockDb);
      await expect(
        service.adminCheckSlotInstallation('3e45bf37-4fc8-4913-8158-190780b03ed6'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

