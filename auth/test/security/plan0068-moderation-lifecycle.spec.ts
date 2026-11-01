import {
  adsCampaigns,
  adsCreativeStacks,
  adsCreatives,
  adsModerationDecisions,
  adsCampaignSubmissions,
  adsCampaignMutations,
  users,
} from '@crimfig/database/schema';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { CampaignWorkflow } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import { ConfigService } from '@nestjs/config';

describe('PLAN-0068 Moderation Lifecycle and Dual Review Invariants', () => {
  const advertiserId = '11111111-1111-4111-8111-111111111111';
  const reviewer1Id = '22222222-2222-4222-8222-222222222222';
  const reviewer2Id = '33333333-3333-4333-8333-333333333333';
  const superAdminId = '44444444-4444-4444-8444-444444444444';
  const campaignId = '55555555-5555-4555-8555-555555555555';
  const stackId = '66666666-6666-4666-8666-666666666666';
  const creativeId = '77777777-7777-4777-8777-777777777777';
  const submissionId = '88888888-8888-4888-8888-888888888888';

  let configService: ConfigService;
  let staffGrants: AdsStaffGrants;

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => {
        if (key === 'ADS_STAFF_ROLE_GRANTS') {
          return JSON.stringify({
            [reviewer1Id]: ['ads_reviewer'],
            [reviewer2Id]: ['ads_manager'],
            [superAdminId]: ['super_admin', 'ads_admin'],
          });
        }
        return null;
      }),
    } as any;
    staffGrants = new AdsStaffGrants(configService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Failure and Rejection First (Negative Cases)', () => {
    it('rejects self-review when advertiser attempts to review their own campaign', async () => {
      const c = {
        id: campaignId,
        advertiserId: reviewer1Id, // Same as reviewer
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'draft',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);

      const db: any = {
        transaction: async (fn: any) => fn({}),
      };

      const service = new ModerationService(db, staffGrants);
      await expect(
        service.reviewCampaignPrimary(campaignId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'approved',
          reviewerId: reviewer1Id,
        }),
      ).rejects.toThrow(/Owners cannot review their own campaigns/);
    });

    it('rejects when rejecting without a reason code or note', async () => {
      const service = new ModerationService({} as any, staffGrants);
      await expect(
        service.reviewCampaignPrimary(campaignId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'rejected',
          reviewerId: reviewer1Id,
        }),
      ).rejects.toThrow(/A rejection reason or note is required when rejecting/);
    });

    it('rejects standard Review 2 if performed by the same reviewer as Review 1', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'paused',
        moderationStatus: 'pending_manager_approval',
        primaryReviewerId: reviewer1Id,
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);
      jest.spyOn(CampaignWorkflow.prototype, 'snapshot').mockResolvedValue({ campaign: c } as any);

      let selectCalls = 0;
      let makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // adsCampaignMutations prior -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => resolve([]);
        return ch;
      };

      const tx: any = { select: makeChain };
      const db: any = { transaction: async (fn: any) => fn(tx) };

      // Stacks query returns an approved stack so reviewer separation is tested
      makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // adsCampaignMutations prior -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => resolve([{ id: stackId, reviewStatus: 'approved', archived: false }]);
        return ch;
      };
      tx.select = makeChain;

      const service = new ModerationService(db, staffGrants);
      await expect(
        service.reviewCampaignManager(campaignId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'approved',
          reviewerId: reviewer1Id, // same as primary reviewer, and not super admin
        }),
      ).rejects.toThrow(/A different reviewer and manager are required for campaign approval/);
    });

    it('rejects approving an ad stack if it contains zero approved ads', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'paused',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);

      let selectCalls = 0;
      let makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // prior mutation -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            if (selectCalls === 3) return [{ id: stackId, campaignId, reviewStatus: 'pending', archived: false }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => {
          // creatives query in stack returns pending (0 approved)
          resolve([{ id: creativeId, reviewStatus: 'pending', status: 'active' }]);
        };
        return ch;
      };

      const tx: any = { select: makeChain };
      const db: any = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ campaignId }],
            }),
          }),
        }),
        transaction: async (fn: any) => fn(tx),
      };

      const service = new ModerationService(db, staffGrants);
      await expect(
        service.reviewStackPrimary(stackId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'approved',
          reviewerId: reviewer1Id,
        }),
      ).rejects.toThrow(/An Ad Stack cannot be approved with zero approved Ads/);
    });

    it('rejects approving a campaign if it contains zero approved ad stacks', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'paused',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);

      let selectCalls = 0;
      let makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // prior mutation -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => {
          // stacks query returns pending (0 approved)
          resolve([{ id: stackId, reviewStatus: 'pending', archived: false }]);
        };
        return ch;
      };

      const tx: any = { select: makeChain };
      const db: any = { transaction: async (fn: any) => fn(tx) };

      const service = new ModerationService(db, staffGrants);
      await expect(
        service.reviewCampaignPrimary(campaignId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'approved',
          reviewerId: reviewer1Id,
        }),
      ).rejects.toThrow(/A campaign cannot be approved with zero approved Ad Stacks/);
    });
  });

  describe('Positive Lifecycle and Auto-Live Execution', () => {
    it('sets campaign to active (LIVE) upon Review 2 manager approval', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'paused',
        moderationStatus: 'pending_manager_approval',
        primaryReviewerId: reviewer1Id,
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);
      jest.spyOn(CampaignWorkflow.prototype, 'snapshot').mockResolvedValue({ campaign: c } as any);
      jest.spyOn(CampaignWorkflow.prototype, 'audit').mockResolvedValue(undefined as any);

      let updatedStatus: string | null = null;
      let updatedModeration: string | null = null;

      let selectCalls = 0;
      let makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // prior mutation -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => {
          resolve([{ id: stackId, reviewStatus: 'approved', archived: false }]);
        };
        return ch;
      };

      const tx: any = {
        select: makeChain,
        update: () => ({
          set: (vals: any) => {
            if (vals.status) updatedStatus = vals.status;
            if (vals.moderationStatus) updatedModeration = vals.moderationStatus;
            return {
              where: () => ({
                returning: async () => [{ ...c, status: vals.status, moderationStatus: vals.moderationStatus }],
              }),
            };
          },
        }),
        insert: () => ({
          values: () => ({
            returning: async () => [{ id: 'mock-decision-id' }],
          }),
        }),
      };
      const db: any = { transaction: async (fn: any) => fn(tx) };

      const service = new ModerationService(db, staffGrants);
      const res: any = await service.reviewCampaignManager(campaignId, {
        expectedRevision: 1,
        requestId: '99999999-9999-4999-8999-999999999999',
        submissionId,
        decision: 'approved',
        reviewerId: reviewer2Id,
        advertiserNote: 'Looks great! Launching to network.',
      });

      expect(updatedModeration).toBe('approved');
      expect(updatedStatus).toBe('active'); // Went live automatically
      expect(res.live).toBe(true);
    });

    it('allows super_admin / platform admin to perform Review 1 and Review 2 sequentially', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'paused',
        moderationStatus: 'pending_manager_approval',
        primaryReviewerId: superAdminId, // Super Admin did Review 1
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);
      jest.spyOn(CampaignWorkflow.prototype, 'snapshot').mockResolvedValue({ campaign: c } as any);
      jest.spyOn(CampaignWorkflow.prototype, 'audit').mockResolvedValue(undefined as any);

      let selectCalls = 0;
      let makeChain = () => {
        const ch: any = {
          from: () => ch,
          where: () => ch,
          limit: async () => {
            selectCalls++;
            if (selectCalls === 1) return []; // prior mutation -> none
            if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }];
            return [];
          },
          orderBy: () => ch,
        };
        ch.then = (resolve: any) => {
          resolve([{ id: stackId, reviewStatus: 'approved', archived: false }]);
        };
        return ch;
      };

      const tx: any = {
        select: makeChain,
        update: () => ({
          set: (vals: any) => ({
            where: () => ({
              returning: async () => [{ ...c, status: vals.status, moderationStatus: vals.moderationStatus }],
            }),
          }),
        }),
        insert: () => ({
          values: () => ({
            returning: async () => [{ id: 'mock-decision-id' }],
          }),
        }),
      };
      const db: any = { transaction: async (fn: any) => fn(tx) };

      const service = new ModerationService(db, staffGrants);

      const res: any = await service.reviewCampaignManager(campaignId, {
        expectedRevision: 1,
        requestId: '99999999-9999-4999-8999-999999999999',
        submissionId,
        decision: 'approved',
        reviewerId: superAdminId, // Allowed because superAdminId has super_admin role
        advertiserNote: 'Platform admin confirmed launch.',
      });

      expect(res.live).toBe(true);
      expect(res.decision).toBeDefined();
    });
  });
});
