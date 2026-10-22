import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BillingEcosystemClient } from '../../../api/ads-api/src/modules/billing/billing-ecosystem.client';

const configuration = (values: Record<string, string> = {}) => ({ get: (key: string) => values[key] }) as any;
const wallet = { userId: 'owner', usd: { availableCents: 0, lockedCents: 100, totalCents: 100 }, ngnEquivalent: { availableAmount: 0, exchangeRate: 1600 } };

describe('Ads Billing boundary', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock; });
  afterEach(() => { global.fetch = originalFetch; });
  const client = (url?: string) => new BillingEcosystemClient(configuration({ INTERNAL_ECOSYSTEM_KEY: 'test-key', ...(url ? { BILLING_API_URL: url } : {}) }));
  const respond = (data: unknown = wallet) => fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'success', data }) });

  it('maps the real Billing shape, preserves zero and uses the versioned route', async () => {
    respond();
    await expect(client().getWalletBalance('owner')).resolves.toMatchObject({ availableUsdCents: 0, lockedUsdCents: 100, totalUsd: 1, estimatedAvailableNgn: 0 });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3008/api/v1/ecosystem/wallets/owner/balance', expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }));
    respond();
    await client('https://billing.example/api/v1/').getWalletBalance('owner');
    expect(fetchMock.mock.calls[1][0]).toBe('https://billing.example/api/v1/ecosystem/wallets/owner/balance');
  });

  it('rejects missing service secrets without a network call', async () => {
    await expect(new BillingEcosystemClient(configuration()).getWalletBalance('owner')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['https://user:secret@example.test', 'https://example.test?key=x', 'file:///tmp/a', 'https://example.test/arbitrary'])('rejects unsafe or ambiguous service URL %s', url => {
    expect(() => client(url)).toThrow();
  });

  it.each(['reserveCampaignEscrow', 'releaseCampaignEscrow'] as const)('does not fabricate success or retry %s after a network failure', async method => {
    fetchMock.mockRejectedValue(new Error('network failure'));
    await expect((client()[method] as any)('owner', 'campaign', 500)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cents %s before a write', async amount => {
    await expect(client().reserveCampaignEscrow('owner', 'campaign', amount)).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an explicit success acknowledgement even on HTTP 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'error' }) });
    await expect(client().reserveCampaignEscrow('owner', 'campaign', 500)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects rejected responses, invalid JSON, foreign wallets and inconsistent balances', async () => {
    for (const response of [
      { ok: false },
      { ok: true, json: async () => { throw new Error('bad JSON'); } },
      { ok: true, json: async () => ({ status: 'success', data: { ...wallet, userId: 'other' } }) },
      { ok: true, json: async () => ({ status: 'success', data: { ...wallet, usd: { ...wallet.usd, totalCents: 99 } } }) },
      { ok: true, json: async () => ({ status: 'success', data: { ...wallet, usd: { ...wallet.usd, availableCents: '0' } } }) },
    ]) {
      fetchMock.mockResolvedValue(response);
      await expect(client().getWalletBalance('owner')).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('requires a matching durable receipt and sends once using the configured key', async () => {
    const service = client('https://billing.example');
    const escrow = { id: 'escrow', userId: 'owner', campaignId: 'campaign', allocatedUsdCents: 500, consumedUsdCents: 0, refundedUsdCents: 0, status: 'active' };
    respond({ escrow, operationId: 'ads-escrow:v2:escrow:reserve:500', transactionId: 'receipt', replayed: false });
    await expect(service.reserveCampaignEscrow('owner', 'campaign', 500)).resolves.toEqual(escrow);
    expect(fetchMock.mock.calls[0][0]).toBe('https://billing.example/api/v1/ecosystem/wallets/owner/campaign-escrows/campaign/reserve');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-internal-key': 'test-key' } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).amountUsdCents).toBe(500);
    respond({ escrow, operationId: 'unconfirmed' });
    await expect(service.reserveCampaignEscrow('owner', 'campaign', 500)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('validates atomic campaign transition and reservation receipt together', async () => {
    const service = client();
    respond({ campaign: { id: 'campaign', advertiserId: 'owner', status: 'active' }, escrow: null });
    await expect(service.changeCampaignStatus('owner', 'campaign', 'active')).rejects.toBeInstanceOf(ServiceUnavailableException);
    respond({ campaign: { id: 'campaign', advertiserId: 'owner', status: 'paused' }, escrow: null, operationId: null, transactionId: null, replayed: true });
    await expect(service.changeCampaignStatus('owner', 'campaign', 'paused')).resolves.toMatchObject({ status: 'paused' });
  });
});
