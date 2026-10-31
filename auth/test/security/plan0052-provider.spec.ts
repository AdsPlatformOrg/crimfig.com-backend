import { IsolatedPaystackAdapter } from '../../../shared/src/financial-security/paystack-adapter';
import { WithdrawalBinding } from '../../../shared/src/financial-security/authorization';
import { FINANCIAL_SECURITY_POLICY as policy } from '../../../shared/src/financial-security/policy.config';

describe('PLAN-0052 isolated provider adapter', () => {
  const binding: WithdrawalBinding = { reference: `wd_${'a'.repeat(40)}`, requestId: 'request', ownerId: 'owner', ownerPersonId: 'person', destinationKey: 'bank-account',
    destinationVersion: 'v1', recipientCode: 'RCP_123', amountUsdCents: 5000, amountKobo: 500000, feeKobo: 5000, exchangeRateId: 'fx', quoteId: 'quote', environment: 'test', policyVersion: policy.version, expiresAt: 1_800_000_060_000 };
  const provider = { reference: binding.reference, amount: binding.amountKobo, recipient: { recipient_code: binding.recipientCode }, currency: 'NGN', domain: 'test', transfer_code: 'TRF_123', status: 'pending' };
  const response = (data: unknown) => ({ ok: true, json: async () => ({ status: true, data }) }) as Response;
  test('missing or wrong-environment key fails before network access', () => {
    const request = jest.fn(); expect(() => new IsolatedPaystackAdapter('', 'test', request)).toThrow();
    expect(() => new IsolatedPaystackAdapter('sk_live_fixture_not_real', 'test', request)).toThrow(); expect(request).not.toHaveBeenCalled();
  });
  test('wrong destination environment fails without sending a transfer', async () => {
    const request = jest.fn(); const adapter = new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request);
    await expect(adapter.submit({ ...binding, environment: 'live' })).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  test.each([{ amount: 1 }, { currency: 'USD' }, { domain: 'live' }, { reference: 'other' }, { recipient: { recipient_code: 'RCP_OTHER' } }, { status: 'invented_success' }])('rejects unbound provider result %j', async change => {
    const request = jest.fn().mockResolvedValue(response({ ...provider, ...change }));
    await expect(new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).submit(binding)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  test('timeout never triggers an automatic second POST', async () => {
    const request = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).submit(binding)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  test('submission uses exact authorized amount and fixed origin', async () => {
    const request = jest.fn().mockResolvedValue(response(provider));
    expect(await new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).submit(binding)).toMatchObject({ reference: binding.reference, receipt: 'TRF_123' });
    expect(request.mock.calls[0][0]).toBe('https://api.paystack.co/transfer');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ amount: binding.amountKobo, reference: binding.reference, recipient: binding.recipientCode });
  });
  test('recovery is read-only and does not equate provider acceptance with completion', async () => {
    const request = jest.fn().mockResolvedValue(response(provider));
    expect((await new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).read(binding)).status).toBe('pending');
    expect(request.mock.calls[0][1].method).toBe('GET');
  });
  test('numeric recipient response requires independent read-only recipient resolution', async () => {
    const request = jest.fn().mockResolvedValueOnce(response({ ...provider, recipient: 12345 })).mockResolvedValueOnce(response(provider));
    expect(await new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).submit(binding)).toMatchObject({ receipt: 'TRF_123' });
    expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
  });
  test('unresolved numeric recipient remains unconfirmed without retrying transfer', async () => {
    const request = jest.fn().mockResolvedValueOnce(response({ ...provider, recipient: 12345 })).mockRejectedValueOnce(new Error('read timeout'));
    await expect(new IsolatedPaystackAdapter('sk_test_fixture_not_real', 'test', request).submit(binding)).rejects.toThrow();
    expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
  });
});
