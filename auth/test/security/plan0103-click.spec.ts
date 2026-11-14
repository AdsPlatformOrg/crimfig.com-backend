import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { FraudRulesService } from '../../../api/ads-api/src/modules/verification/fraud-rules.service';

describe('PLAN0103 click redirect assessment ownership (mocked persistence)', () => {
  const claims = { campaignId: 'campaign', creativeId: 'creative', promoterId: 'publisher', placementId: 'placement', servedId: 'serve', timestamp: Date.now() - 1000 };
  function fixture() {
    const chain: any = { from: () => chain, where: () => chain, limit: async () => [{
      status: 'active', contentSnapshot: { destinationUrl: 'https://example.test/landing' },
    }] };
    const db: any = { select: () => chain, update: jest.fn(() => ({ set: () => ({ where: async () => undefined }) })), insert: jest.fn(() => ({ values: jest.fn(async () => undefined) })) };
    const fraud = new FraudRulesService();
    const validate = jest.spyOn(fraud, 'validateClick');
    const delivery = new DeliveryService(db, { verifyToken: () => claims } as any, {} as any, fraud);
    jest.spyOn(delivery as any, 'boundServe').mockResolvedValue(true);
    const log = jest.spyOn(delivery, 'logInteraction').mockImplementation(async () => {
      const result = fraud.validateClick({ placementId: claims.placementId, serveId: claims.servedId, userAgent: 'Mozilla/5.0 Chrome/130', tokenTimestampMs: claims.timestamp });
      return { id: 'event', ...result } as any;
    });
    return { delivery, db, validate, log };
  }

  test('mismatched serve never consumes dedupe state or writes a click', async () => {
    const f = fixture();
    (f.delivery as any).boundServe.mockResolvedValue(false);
    await expect(f.delivery.handleClick('signed')).rejects.toThrow('does not match');
    expect(f.validate).not.toHaveBeenCalled(); expect(f.log).not.toHaveBeenCalled(); expect(f.db.insert).not.toHaveBeenCalled();
  });

  test('event ingestion failure preserves a receipt and allows navigation', async () => {
    const f = fixture(); f.log.mockRejectedValue(new Error('storage unavailable'));
    await expect(f.delivery.handleClick('signed')).resolves.toContain('cf_click=');
    expect(f.validate).not.toHaveBeenCalled(); expect(f.db.insert).toHaveBeenCalledTimes(1); expect(f.db.update).not.toHaveBeenCalled();
  });

  test('redirect assesses the first click once; a subsequent click remains a duplicate', async () => {
    const f = fixture();
    expect(await f.delivery.handleClick('signed')).toMatch(/^https:\/\/example.test\/landing\?cf_click=clk_/);
    expect(f.validate).toHaveBeenCalledTimes(1);
    expect(await f.log.mock.results[0].value).toMatchObject({ isValid: true });
    await f.delivery.handleClick('signed');
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(await f.log.mock.results[1].value).toMatchObject({ isValid: false, reasonCode: 'DUP_CLICK' });
  });
});
