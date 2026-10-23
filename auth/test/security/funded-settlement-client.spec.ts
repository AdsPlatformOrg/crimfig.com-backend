import { randomUUID } from 'crypto';
import { BillingEcosystemClient } from '../../../api/ads-api/src/modules/billing/billing-ecosystem.client';

describe('Funded settlement transport', () => {
  const campaignId = randomUUID(), requestId = randomUUID(), periodEnd = '2026-01-01T00:00:00.000Z';
  const client = () => new BillingEcosystemClient({ get: (key: string) => key === 'INTERNAL_ECOSYSTEM_KEY' ? 'test-only-service-key' : undefined } as any);
  afterEach(() => jest.restoreAllMocks());
  test('ambiguous response sends one request and preserves the durable recovery identity', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockRejectedValue(Error('lost acknowledgement'));
    await expect(client().settleCampaign(campaignId, requestId, periodEnd)).rejects.toThrow('same request UUID');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ requestId, periodEnd });
  });
  test('accepts only a completed authoritative batch receipt', async () => {
    const data = { batchId: randomUUID(), status: 'completed', billedUsdCents: 10, replayed: true };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ status: 'success', data }) } as any);
    expect(await client().settleCampaign(campaignId, requestId, periodEnd)).toEqual(data);
    data.billedUsdCents = -1;
    await expect(client().settleCampaign(campaignId, requestId, periodEnd)).rejects.toThrow('unconfirmed');
  });
});
