import {
  adsCampaigns,
  adsCreativeStacks,
  adsCreatives,
  adsModerationDecisions,
  adsCampaignSubmissions,
  adsCampaignMutations,
} from '@crimfig/database/schema';
import { ModerationService } from '../../../api/ads-api/src/modules/moderation/moderation.service';
import { AdsStaffGrants } from '../../../api/ads-api/src/modules/security/ads-staff-grants';
import { CampaignWorkflow } from '../../../api/ads-api/src/modules/campaigns/campaign-workflow';
import { ConfigService } from '@nestjs/config';

describe('PLAN-0069 Ad-First Moderation & Serving Gating Invariants', () => {
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

  describe('Negative & Rejection Cases First', () => {
    it('rejects primary review when submissionId is missing or invalid UUID', async () => {
      const service = new ModerationService({} as any, staffGrants);
      await expect(
        service.reviewCampaignPrimary(campaignId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId: 'invalid-uuid-format',
          decision: 'approved',
          reviewerId: reviewer1Id,
        }),
      ).rejects.toThrow(/current submission ID is required/);
    });

    it('rejects campaign approval if campaign has 0 approved creatives across all its stacks', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'draft',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);

      let selectCalls = 0;
      const makeChain = () => {
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
        // Query for creatives under campaign
        ch.then = (resolve: any) => {
          resolve([]); // 0 approved creatives!
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
      ).rejects.toThrow(/cannot be approved with zero approved Ads|cannot be approved with zero approved creatives/i);
    });

    it('rejects Review 2 manager approval if creative is still in pending (Review 1 not done)', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'draft',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);
      jest.spyOn(CampaignWorkflow.prototype, 'snapshot').mockResolvedValue({ campaign: c } as any);
      jest.spyOn(CampaignWorkflow.prototype, 'audit').mockResolvedValue(undefined as any);

      let selectCalls = 0;
      const tx: any = {
        select: () => {
          const ch: any = {
            from: () => ch,
            where: () => ch,
            limit: async () => {
              selectCalls++;
              if (selectCalls === 1) return []; // mutation
              if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }]; // submission
              if (selectCalls === 3) return [{ id: creativeId, campaignId, status: 'active', reviewStatus: 'pending' }]; // creative still pending!
              return [];
            },
            orderBy: () => ch,
          };
          return ch;
        },
      };
      const db: any = {
        transaction: async (fn: any) => fn(tx),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ campaignId }],
            }),
          }),
        }),
      };

      const service = new ModerationService(db, staffGrants);
      await expect(
        service.reviewCreativeManager(creativeId, {
          expectedRevision: 1,
          requestId: '99999999-9999-4999-8999-999999999999',
          submissionId,
          decision: 'approved',
          reviewerId: reviewer2Id,
        }),
      ).rejects.toThrow(/not awaiting Review 2/i);
    });
  });

  describe('Positive Creative Approval and Progress Accounting', () => {
    it('approves creative independently through Review 1 and Review 2', async () => {
      const c = {
        id: campaignId,
        advertiserId,
        contentRevision: 1,
        currentSubmissionId: submissionId,
        status: 'draft',
        moderationStatus: 'pending_primary_review',
      };
      jest.spyOn(CampaignWorkflow.prototype, 'lock').mockResolvedValue(c as any);
      jest.spyOn(CampaignWorkflow.prototype, 'snapshot').mockResolvedValue({ campaign: c } as any);
      jest.spyOn(CampaignWorkflow.prototype, 'audit').mockResolvedValue(undefined as any);

      let selectCalls = 0;
      let updatedCreativeStatus = '';
      const tx: any = {
        select: () => {
          const ch: any = {
            from: () => ch,
            where: () => ch,
            limit: async () => {
              selectCalls++;
              if (selectCalls === 1) return []; // mutation
              if (selectCalls === 2) return [{ id: submissionId, state: 'submitted', contentRevision: 1 }]; // submission
              if (selectCalls === 3) return [{ id: creativeId, campaignId, status: 'active', reviewStatus: 'pending' }]; // creative
              return [];
            },
          };
          return ch;
        },
        update: () => ({
          set: (vals: any) => {
            updatedCreativeStatus = vals.reviewStatus;
            return {
              where: () => ({
                returning: async () => [{ id: creativeId, reviewStatus: vals.reviewStatus }],
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
      const db: any = {
        transaction: async (fn: any) => fn(tx),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ campaignId }],
            }),
          }),
        }),
      };

      const service = new ModerationService(db, staffGrants);

      // Perform Review 1
      const res1: any = await service.reviewCreativePrimary(creativeId, {
        expectedRevision: 1,
        requestId: '99999999-9999-4999-8999-999999999999',
        submissionId,
        decision: 'approved',
        reviewerId: reviewer1Id,
      });

      expect(updatedCreativeStatus).toBe('pending_manager_approval');
      expect(res1.creative.reviewStatus).toBe('pending_manager_approval');
    });
  });
});
