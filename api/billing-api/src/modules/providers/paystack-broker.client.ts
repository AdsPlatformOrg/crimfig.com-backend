import {ServiceUnavailableException} from '@nestjs/common';
import {signPrivateRequest,readPrivateResponse,PrivateResponse} from '@crimfig/shared';
export class PaystackBrokerClient {
  private async call(path:string,body:unknown):Promise<any>{
    const url=new URL(process.env.FINANCIAL_AUTHORITY_URL||'');
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new ServiceUnavailableException('Provider gateway unavailable');
    const key=process.env.BILLING_FINANCIAL_WORKLOAD_PRIVATE_KEY,keyId=process.env.BILLING_FINANCIAL_WORKLOAD_KEY_ID;
    if(!key||!keyId)throw new ServiceUnavailableException('Provider workload identity unavailable');
    const request=signPrivateRequest(path,body,keyId,key);
    const response=await fetch(`${url.origin}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    if(!response.ok)throw new ServiceUnavailableException('Provider gateway request unavailable');
    return readPrivateResponse(await response.json() as PrivateResponse,request,JSON.parse(process.env.FINANCIAL_AUTHORITY_PUBLIC_KEYS||'{}'));
  }
  async request(url:string,init:RequestInit={}):Promise<Response>{
    const parsed=new URL(url);if(parsed.origin!=='https://api.paystack.co')throw new Error('Unexpected provider origin');
    const result=await this.call('/internal/v1/provider/request',{path:parsed.pathname+parsed.search,method:init.method||'GET',...(init.body?{body:JSON.parse(init.body as string)}:{})});
    if(!Number.isInteger(result?.status)||result.status<200||result.status>599)throw new Error('Invalid provider gateway receipt');
    return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json'}});
  }
  async verifyWebhook(rawBody:string|Buffer,signature:string):Promise<boolean>{
    const result=await this.call('/internal/v1/provider/webhook',{rawBase64:Buffer.from(rawBody).toString('base64'),signature});
    return result?.valid===true;
  }
}
