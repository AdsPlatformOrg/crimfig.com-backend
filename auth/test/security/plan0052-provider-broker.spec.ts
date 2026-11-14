import {createHmac} from 'crypto';
import {PaystackProviderBroker} from '../../../shared/src/financial-security/provider-broker';
describe('isolated provider credential broker',()=>{
  const secret='sk_test_unit_fixture_not_real';
  test.each(['/transfer','/transfer/bulk','/refund','https://attacker.invalid','/transaction/verify/a/../../transfer'])('rejects unsupported operation %s before network',async path=>{
    const request=jest.fn();await expect(new PaystackProviderBroker(secret,request).call({path,method:'POST'})).rejects.toThrow();expect(request).not.toHaveBeenCalled();
  });
  test('forged or changed webhook bytes cannot authenticate',()=>{
    const broker=new PaystackProviderBroker(secret),raw='{"event":"charge.success"}',signature=createHmac('sha512',secret).update(raw).digest('hex');
    expect(broker.verifyWebhook(Buffer.from(raw+' ').toString('base64'),signature)).toBe(false);
    expect(broker.verifyWebhook(Buffer.from(raw).toString('base64'),'bad')).toBe(false);
    expect(broker.verifyWebhook(Buffer.from(raw).toString('base64'),signature)).toBe(true);
  });
  test('allowed read uses fixed origin and isolated credential',async()=>{
    const request=jest.fn().mockResolvedValue({status:200,json:async()=>({status:true})});
    await new PaystackProviderBroker(secret,request).call({path:'/transaction/verify/reference',method:'GET'});
    expect(request.mock.calls[0][0]).toBe('https://api.paystack.co/transaction/verify/reference');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer '+secret);
  });
  test('large bank directory projects public fields before receipt signing', async () => {
    const banks = Array.from({ length: 300 }, (_, id) => ({ id, name: 'Fixture Bank', code: String(id), slug: 'fixture', providerMetadata: 'x'.repeat(500) }));
    const request = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ status: true, data: banks }) });
    const result: any = await new PaystackProviderBroker(secret, request).call({ path: '/bank?country=nigeria&perPage=100', method: 'GET' });
    expect(result.body.data).toHaveLength(300);
    expect(result.body.data[0]).toEqual({ id: 0, name: 'Fixture Bank', code: '0', slug: 'fixture' });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
  });
});
