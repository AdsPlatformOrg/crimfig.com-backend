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
});
