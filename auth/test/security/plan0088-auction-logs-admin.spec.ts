import { AdsOperationsService } from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';

describe('PLAN-0088: Admin Console Auction Logs & Trace Inspector', () => {
  let mockDb: any;
  let mockQuery: any;

  beforeEach(() => {
    mockQuery = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
    };
    mockDb = {
      select: jest.fn().mockReturnValue(mockQuery),
    };
  });

  describe('listAuctionDecisions', () => {
    it('defaults to 100 records and computes totalPages correctly', async () => {
      const records = Array.from({ length: 100 }, (_, i) => ({
        requestId: `req-${i}`,
        slotTagId: 'cf-slot-network-test',
        inventoryClass: 'house',
        decisionStage: 'slot_gate',
        reasonCode: 'SLOT_TESTING_MODE',
        createdAt: new Date(),
      }));

      // In listAuctionDecisions:
      // First select is count: db.select(...).from(...).where(...) => returns [{ count: 250 }]
      // Second select is rows: db.select().from(...).where(...).orderBy(...).limit(...).offset(...) => returns records
      mockQuery.where.mockResolvedValueOnce([{ count: 250 }]);
      mockQuery.offset.mockResolvedValueOnce(records);

      const service = new (AdsOperationsService as any)(mockDb);
      const result = await service.listAuctionDecisions({});

      expect(result.pageSize).toBe(100);
      expect(result.page).toBe(1);
      expect(result.total).toBe(250);
      expect(result.totalPages).toBe(3);
      expect(result.items).toHaveLength(100);
    });

    it('filters by inventoryClass (paid / house / shadow)', async () => {
      mockQuery.where.mockResolvedValueOnce([{ count: 12 }]);
      mockQuery.offset.mockResolvedValueOnce([{ requestId: 'req-house-1', inventoryClass: 'house' }]);

      const service = new (AdsOperationsService as any)(mockDb);
      const result = await service.listAuctionDecisions({ inventoryClass: 'house', pageSize: 10 });

      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(12);
      expect(result.totalPages).toBe(2);
      expect(result.items[0].inventoryClass).toBe('house');
    });

    it('applies search across slotTagId and requestId', async () => {
      mockQuery.where.mockResolvedValueOnce([{ count: 1 }]);
      mockQuery.offset.mockResolvedValueOnce([{ requestId: 'req-specific-123', slotTagId: 'cf-slot-network-1dce0fa5ce5342cd' }]);

      const service = new (AdsOperationsService as any)(mockDb);
      const result = await service.listAuctionDecisions({ search: '1dce0fa5ce5342cd' });

      expect(result.total).toBe(1);
      expect(result.items[0].slotTagId).toBe('cf-slot-network-1dce0fa5ce5342cd');
    });
  });

  describe('getAuctionDecision', () => {
    it('returns null when auction decision does not exist', async () => {
      mockQuery.limit.mockResolvedValueOnce([]); // no decision found

      const service = new (AdsOperationsService as any)(mockDb);
      const result = await service.getAuctionDecision('non-existent-uuid');
      expect(result).toBeNull();
    });

    it('returns full trace enriched with website and slot details when found', async () => {
      const decisionRow = {
        requestId: 'req-valid-1',
        slotId: '3e45bf37-4fc8-4913-8158-190780b03ed6',
        websiteId: '72e4b4b9-e20b-4ba6-a073-8901cbe10cbd',
        slotTagId: 'cf-slot-network-1dce0fa5ce5342cd',
        inventoryClass: 'house',
        decisionStage: 'slot_gate',
        reasonCode: 'SLOT_TESTING_MODE',
        preAuctionCheckPass: false,
        websiteSuitabilityStatus: 'approved',
        slotInstallationStatus: 'VERIFIED',
        eligibleCandidatesCount: 0,
        candidateRejectionsJson: [{ candidateId: 'cand-1', stage: 'geo', reasonCode: 'TARGETING_GEO_MISMATCH' }],
        createdAt: new Date(),
      };

      const slotRow = {
        id: '3e45bf37-4fc8-4913-8158-190780b03ed6',
        name: 'PLAN-0053 staging house-ad pilot',
        format: 'banner',
        lifecycleStatus: 'active',
        installationStatus: 'VERIFIED',
      };

      const websiteRow = {
        id: '72e4b4b9-e20b-4ba6-a073-8901cbe10cbd',
        domain: 'jed.com.ng',
        verificationStatus: 'verified',
        policyStatus: 'approved',
      };

      mockQuery.limit
        .mockResolvedValueOnce([decisionRow]) // decision query
        .mockResolvedValueOnce([websiteRow]) // website query
        .mockResolvedValueOnce([slotRow]); // slot query

      const service = new (AdsOperationsService as any)(mockDb);
      const result = await service.getAuctionDecision('req-valid-1');

      expect(result.requestId).toBe('req-valid-1');
      expect(result.reasonCode).toBe('SLOT_TESTING_MODE');
      expect(result.slot).toBeDefined();
      expect(result.slot.name).toBe('PLAN-0053 staging house-ad pilot');
      expect(result.website).toBeDefined();
      expect(result.website.domain).toBe('jed.com.ng');
    });
  });
});
