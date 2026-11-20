import { PaystackBrokerClient } from '../../../api/billing-api/src/modules/providers/paystack-broker.client';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';

describe('Transfer provider request boundary (no network)', () => {
  const reference = 'wd_1234567890123456789012345678901234567890';
  let previous: string | undefined;
  const previousMode = process.env.PAYSTACK_MODE;
  beforeEach(() => {
    previous = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
    process.env.PAYSTACK_MODE = 'test';
    // This suite tests PaystackService's request and response contract. Signed
    // broker transport has its own independent boundary tests.
    jest.spyOn(PaystackBrokerClient.prototype, 'assertConfigured').mockReturnValue({} as any);
    jest.spyOn(PaystackBrokerClient.prototype, 'request').mockImplementation((url, init) => global.fetch(url, init));
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.PAYSTACK_MODE;
    else process.env.PAYSTACK_MODE = previousMode;
  });
  afterEach(() => { jest.restoreAllMocks(); if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previous; });
  it('blocks direct Billing payouts before contacting the provider', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'}))
      .rejects.toThrow('Direct Billing payouts are disabled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed request before sending', async () => {
    const fetch = jest.spyOn(global,'fetch');
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:0.5,recipientCode:'RCP_fixture'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never dispatches a direct payout even when transport is unavailable', async () => {
    const fetch = jest.spyOn(global,'fetch').mockRejectedValue(Error('timeout'));
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{status:false,data:{reference}}, {status:true,data:{reference:'foreign'}}, {status:'true',data:{reference}}])('blocks direct dispatch regardless of an untrusted acknowledgement %j',async body=>{
    jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'})).rejects.toThrow();
  });
  it('recovery performs only GET and preserves not-found as uncertainty',async()=>{
    const fetch=jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify({status:false}),{status:404}));
    await expect(new PaystackService().verifyTransfer(reference)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toBe('https://api.paystack.co/transfer/verify/'+reference);
    expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
  });
  it('bank directory failure stays unavailable rather than becoming a confirmed empty list', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ status: false, data: [] }, { status: 503 }));
    await expect(new PaystackService().listBanks()).rejects.toThrow('temporarily unavailable');
  });
  it('account resolution is bounded and rejects a provider response for a different account', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ status: true, data: { account_number: '1111111111', account_name: 'Different account' } }));
    await expect(new PaystackService().resolveAccount('0000000000', '057')).rejects.toThrow();
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' }); expect(fetch.mock.calls[0][1]?.signal).toBeDefined();
  });
  it.each([{ account_number: '1111111111', bank_code: '057' }, { account_number: '0000000000', bank_code: '044' }])('recipient response cannot change the verified bank binding %j', async details => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ status: true, data: { recipient_code: 'RCP_fixture', details } }));
    await expect(new PaystackService().createTransferRecipient({ name: 'TEST recipient', accountNumber: '0000000000', bankCode: '057' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.signal).toBeDefined();
  });
});
