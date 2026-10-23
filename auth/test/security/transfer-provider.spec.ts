import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';

describe('Transfer provider request boundary (no network)', () => {
  const reference = 'wd_1234567890123456789012345678901234567890';
  let previous: string | undefined;
  beforeEach(() => { previous = process.env.PAYSTACK_SECRET_KEY; process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only'; });
  afterEach(() => { jest.restoreAllMocks(); if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previous; });
  it('sends one bound NGN transfer with timeout and redirect rejection', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({status:true,data:{reference,status:'pending'}})));
    await new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'});
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.paystack.co/transfer');
    expect(init?.redirect).toBe('error'); expect(init?.signal).toBeDefined();
    expect(JSON.parse(init?.body as string)).toMatchObject({reference,currency:'NGN',amount:50000,recipient:'RCP_fixture'});
  });
  it('rejects malformed request before sending', async () => {
    const fetch = jest.spyOn(global,'fetch');
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:0.5,recipientCode:'RCP_fixture'})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not retry uncertain transfer creation', async () => {
    const fetch = jest.spyOn(global,'fetch').mockRejectedValue(Error('timeout'));
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{status:false,data:{reference}}, {status:true,data:{reference:'foreign'}}, {status:'true',data:{reference}}])('rejects an invalid transfer acknowledgement %j',async body=>{
    jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new PaystackService().initiateTransfer({reference,amountKobo:50000,recipientCode:'RCP_fixture'})).rejects.toThrow();
  });
  it('recovery performs only GET and preserves not-found as uncertainty',async()=>{
    const fetch=jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify({status:false}),{status:404}));
    await expect(new PaystackService().verifyTransfer(reference)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toBe('https://api.paystack.co/transfer/verify/'+reference);
    expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
  });
});
