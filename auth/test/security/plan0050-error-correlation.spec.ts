import {HttpException,Logger} from '@nestjs/common';
import {AdsGlobalExceptionFilter} from '../../../api/ads-api/src/modules/security/ads-exception.filter';
describe('PLAN-0050 monitor/error correlation — failures first',()=>{
  afterEach(()=>jest.restoreAllMocks());
  it('does not expose raw provider error, URL query, credentials or an invalid caller ID',()=>{
    const log=jest.spyOn(Logger.prototype,'error').mockImplementation(()=>undefined);
    const response:any={setHeader:jest.fn(),status:jest.fn().mockReturnThis(),json:jest.fn()};
    const request:any={method:'POST',headers:{'x-request-id':'SECRET'},route:{path:'/campaigns/:id'},url:'/campaigns/id?token=SECRET'};
    const host:any={switchToHttp:()=>({getResponse:()=>response,getRequest:()=>request})};
    new AdsGlobalExceptionFilter().catch(new Error('postgres password=SECRET'),host);
    const body=response.json.mock.calls[0][0];expect(body.code).toBe('INTERNAL_ERROR');expect(JSON.stringify(body)).not.toContain('SECRET');expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
  it('keeps the interceptor request ID consistent in response body, header and safe error log',()=>{
    const id='11111111-1111-4111-8111-111111111111';const log=jest.spyOn(Logger.prototype,'error').mockImplementation(()=>undefined);
    const response:any={setHeader:jest.fn(),status:jest.fn().mockReturnThis(),json:jest.fn()};
    const request:any={method:'POST',requestId:id,headers:{},route:{path:'/campaigns/:id'}};
    new AdsGlobalExceptionFilter().catch(new HttpException('raw provider detail',503),{switchToHttp:()=>({getResponse:()=>response,getRequest:()=>request})} as any);
    expect(response.json.mock.calls[0][0].requestId).toBe(id);expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id',id);expect(log.mock.calls[0][0]).toContain(id);
  });
});
