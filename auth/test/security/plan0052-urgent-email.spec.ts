import { BrevoUrgentEmailTransport } from '../../../shared/src/financial-security/urgent-email';
describe('dedicated urgent email transport',()=>{
  const input={messageId:'stable-id',recipient:'owner@example.invalid',subject:'Financial alert',text:'Review the authenticated console'};
  test('missing credentials reject before any request',()=>{
    const request=jest.fn();expect(()=>new BrevoUrgentEmailTransport('','sender@example.invalid',request)).toThrow();expect(request).not.toHaveBeenCalled();
  });
  test('timeout is unconfirmed and never automatically retried',async()=>{
    const request=jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(new BrevoUrgentEmailTransport('fixture','sender@example.invalid',request).submit(input)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
  });
  test('missing provider receipt cannot be reported accepted',async()=>{
    const request=jest.fn().mockResolvedValue({ok:true,json:async()=>({})});
    await expect(new BrevoUrgentEmailTransport('fixture','sender@example.invalid',request).submit(input)).rejects.toThrow();
  });
  test('provider acceptance preserves stable message identity',async()=>{
    const request=jest.fn().mockResolvedValue({ok:true,json:async()=>({messageId:'provider-id'})});
    expect(await new BrevoUrgentEmailTransport('fixture','sender@example.invalid',request).submit(input)).toEqual({providerId:'provider-id'});
    expect(JSON.parse(request.mock.calls[0][1].body).headers['X-CrimFig-Alert-ID']).toBe('stable-id');
  });
});
