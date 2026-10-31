import {createHmac,timingSafeEqual} from 'crypto';
export interface ProviderBrokerRequest {path:string;method:'GET'|'POST';body?:unknown}
/** No transfer, refund, bulk payout, arbitrary host or arbitrary header operation exists here. */
export class PaystackProviderBroker {
  constructor(private readonly secret:string,private readonly request:typeof fetch=fetch){
    if(!/^sk_(test|live)_/.test(secret))throw new Error('Provider broker credentials unavailable');
  }
  domain():'test'|'live'{return this.secret.startsWith('sk_live_')?'live':'test';}
  verifyWebhook(rawBase64:string,signature:string):boolean{
    if(typeof rawBase64!=='string'||rawBase64.length>180000||!/^[a-f0-9]{128}$/i.test(signature))return false;
    const actual=createHmac('sha512',this.secret).update(Buffer.from(rawBase64,'base64')).digest();
    return timingSafeEqual(actual,Buffer.from(signature,'hex'));
  }
  async call(input:ProviderBrokerRequest):Promise<{status:number;body:unknown}>{
    const allowed=input.method==='GET'
      ? /^\/(transaction\/verify\/[A-Za-z0-9_-]+|transfer\/verify\/[A-Za-z0-9_-]+|bank\?country=nigeria&perPage=100|bank\/resolve\?account_number=\d{10}&bank_code=\d{1,10})$/.test(input.path)
      : input.method==='POST'&&['/transaction/initialize','/transaction/charge_authorization','/customer/deactivate_authorization','/transferrecipient'].includes(input.path);
    if(!allowed)throw new Error('Provider broker operation denied');
    const response=await this.request(`https://api.paystack.co${input.path}`,{method:input.method,redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${this.secret}`,'Content-Type':'application/json'},...(input.method==='POST'?{body:JSON.stringify(input.body)}:{})});
    return {status:response.status,body:await response.json()};
  }
}
