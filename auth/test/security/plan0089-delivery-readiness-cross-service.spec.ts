import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';

describe('PLAN-0089: Cross-Service Blocker Visibility & Account Status in Campaign Readiness', () => {
  let mockDb: any;
  let mockTx: any;
  let mockQuery: any;

  beforeEach(() => {
    mockQuery = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
    };
    mockTx = {
      execute: jest.fn().mockResolvedValue({}),
      select: jest.fn().mockReturnValue(mockQuery),
    };
    mockDb = {
      transaction: jest.fn().mockImplementation(async (cb) => cb(mockTx)),
      select: jest.fn().mockReturnValue(mockQuery),
    };
  });

  describe('staffCampaignPage (Directory listing)', () => {
    it('projects advertiserAccountStatus and advertiserEmailVerified in staff directory', async () => {
      const mockCampaignRows = [
        {
          id: '5837d2c4-eb9d-4295-ad8d-a50341b47824',
          title: 'Jed Test Campaign',
          advertiserId: '4c6729b9-1b8d-4b11-b69d-de7a81fcb883',
          advertiserEmail: 'jedoskistaging1@yopmail.com',
          advertiserAccountStatus: 'PENDING_VERIFICATION',
          advertiserEmailVerified: false,
          status: 'active',
          moderationStatus: 'approved',
          budgetUsdCents: 5000,
          dailyBudgetUsdCents: 500,
          remainingBudgetUsdCents: 5000,
          pricingModel: 'cpc',
          format: 'card',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // Query 1: rows query ending in .offset(...)
      // Query 2: totalRow query ending in .where(...)
      mockQuery.offset.mockResolvedValueOnce(mockCampaignRows);
      mockQuery.where = jest.fn().mockImplementation(() => {
        // Return mockQuery so chaining .orderBy().limit().offset() works,
        // and also allow it to be resolved directly for the count query.
        const p: any = Promise.resolve([{ count: 1 }]);
        p.from = mockQuery.from;
        p.leftJoin = mockQuery.leftJoin;
        p.where = mockQuery.where;
        p.orderBy = mockQuery.orderBy;
        p.limit = mockQuery.limit;
        p.offset = mockQuery.offset;
        return p;
      });

      const service = new (CampaignsService as any)(mockDb);
      const result = await service.staffCampaignPage(1, 25);

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.advertiserAccountStatus).toBe('PENDING_VERIFICATION');
      expect(item.advertiserEmailVerified).toBe(false);
      expect(item.budgetUsd).toBe(50);
      expect(item.remainingBudgetUsd).toBe(50);
    });
  });

  describe('getDeliveryReadiness (Single Campaign Deep Diagnostics)', () => {
    it('asserts failure first: marks BILLING_RESERVATION_ELIGIBILITY and ADVERTISER_ACCOUNT as blocked when advertiser is PENDING_VERIFICATION', async () => {
      const campaignId = '5837d2c4-eb9d-4295-ad8d-a50341b47824';
      const advertiserId = '4c6729b9-1b8d-4b11-b69d-de7a81fcb883';

      const mockCampaign = {
        id: campaignId,
        advertiserId,
        status: 'active',
        moderationStatus: 'approved',
        contentRevision: 2,
        approvedRevision: 2,
        currentSubmissionId: 'sub-1',
        approvedSubmissionId: 'sub-1',
        submissionIntentId: null,
        remainingBudgetUsdCents: 5000,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: null,
      };

      mockQuery.limit
        .mockResolvedValueOnce([mockCampaign]) // campaign
        .mockResolvedValueOnce([{ status: 'PENDING_VERIFICATION', verified: false }]) // account
        .mockResolvedValueOnce([{ status: 'active', owner: advertiserId }]) // escrow
        .mockResolvedValueOnce([]); // serves

      const service = new (CampaignsService as any)(mockDb);
      const report = await service.getDeliveryReadiness(campaignId, advertiserId);

      expect(report.gates).toBeDefined();

      const accountGate = report.gates.find((g: any) => g.gateCode === 'ADVERTISER_ACCOUNT');
      expect(accountGate).toBeDefined();
      expect(accountGate.status).toBe('blocked');
      expect(accountGate.explanation).toContain('active advertiser account');

      const billingGate = report.gates.find((g: any) => g.gateCode === 'BILLING_RESERVATION_ELIGIBILITY');
      expect(billingGate).toBeDefined();
      expect(billingGate.status).toBe('blocked');
      expect(billingGate.owner).toBe('Advertiser');
      expect(billingGate.explanation).toContain('PENDING_VERIFICATION');
      expect(billingGate.action).toBe('verify_email');

      const escrowGate = report.gates.find((g: any) => g.gateCode === 'CAMPAIGN_ESCROW');
      expect(escrowGate.status).toBe('eligible');
    });

    it('passes BILLING_RESERVATION_ELIGIBILITY and ADVERTISER_ACCOUNT when advertiser is ACTIVE and verified', async () => {
      const campaignId = '5837d2c4-eb9d-4295-ad8d-a50341b47824';
      const advertiserId = '4c6729b9-1b8d-4b11-b69d-de7a81fcb883';

      const mockCampaign = {
        id: campaignId,
        advertiserId,
        status: 'active',
        moderationStatus: 'approved',
        contentRevision: 2,
        approvedRevision: 2,
        currentSubmissionId: 'sub-1',
        approvedSubmissionId: 'sub-1',
        submissionIntentId: null,
        remainingBudgetUsdCents: 5000,
        startsAt: new Date(Date.now() - 3600000),
        endsAt: null,
      };

      mockQuery.limit
        .mockResolvedValueOnce([mockCampaign])
        .mockResolvedValueOnce([{ status: 'ACTIVE', verified: true }])
        .mockResolvedValueOnce([{ status: 'active', owner: advertiserId }])
        .mockResolvedValueOnce([]);

      const service = new (CampaignsService as any)(mockDb);
      const report = await service.getDeliveryReadiness(campaignId, advertiserId);

      const accountGate = report.gates.find((g: any) => g.gateCode === 'ADVERTISER_ACCOUNT');
      expect(accountGate.status).toBe('eligible');

      const billingGate = report.gates.find((g: any) => g.gateCode === 'BILLING_RESERVATION_ELIGIBILITY');
      expect(billingGate.status).toBe('eligible');
      expect(billingGate.explanation).toContain('Billing can reserve delivery opportunities');
    });
  });
});
