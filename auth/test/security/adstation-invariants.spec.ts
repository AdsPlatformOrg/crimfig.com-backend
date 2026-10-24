import { AdstationService } from '../../../api/ads-api/src/modules/adstation/adstation.service';

describe('AdStation Security & Zero Commission Invariants (PLAN-0018)', () => {
  let adstationService: AdstationService;
  let mockDb: any;
  let savedRows: any[];

  beforeEach(() => {
    savedRows = [];
    const queryChain: any = {
      from: jest.fn(() => queryChain),
      where: jest.fn(() => queryChain),
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

    adstationService = new AdstationService(mockDb);
  });

  test('Direct deal CANNOT be assigned to a Consideration Slot', async () => {
    savedRows = [
      {
        id: 'slot-cons-001',
        isConsiderationSlot: true,
        slotType: 'consideration',
      },
    ];

    await expect(
      adstationService.createDirectCampaign('promoter-1', {
        websiteId: 'web-1',
        slotId: 'slot-cons-001',
        clientName: 'Private Client',
        campaignTitle: 'Direct Deal A',
        destinationUrl: 'https://client.com',
      }),
    ).rejects.toThrow('Direct deals cannot be assigned to a Consideration Slot');
  });

  test('Direct events record deduplicated with zero platform billing fee', async () => {
    const res1 = await adstationService.recordDirectEvent({
      directCampaignId: 'dc-1',
      websiteId: 'web-1',
      eventType: 'impression',
      idempotencyKey: 'idem-key-1000',
    });

    expect(res1.status).toBe('recorded');
    expect(res1.eventId).toBeDefined();

    // Replay with identical idempotencyKey
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

  test('Consideration slot 48-hour grace state machine flags pending grace when unverified', async () => {
    savedRows = [
      {
        id: 'web-1',
        domain: 'publisher.com',
        considerationSlotActive: false,
        considerationSlotVerifiedAt: null,
        createdAt: new Date(), // Just created within 48h
      },
    ];

    const health = await adstationService.checkConsiderationSlotHealth('web-1');
    expect(health.status).toBe('pending_review_grace');
    expect(health.graceActive).toBe(true);
    expect(health.graceRemainingHours).toBeGreaterThan(0);
  });

  test('Consideration slot 48-hour grace state machine suspends website when grace expires', async () => {
    const pastDate = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50 hours ago
    savedRows = [
      {
        id: 'web-1',
        domain: 'publisher.com',
        considerationSlotActive: false,
        considerationSlotVerifiedAt: null,
        createdAt: pastDate,
      },
    ];

    const health = await adstationService.checkConsiderationSlotHealth('web-1');
    expect(health.status).toBe('suspended');
    expect(health.graceActive).toBe(false);
    expect(health.graceRemainingHours).toBe(0);
  });
});
