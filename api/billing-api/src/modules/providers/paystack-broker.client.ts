import {createPrivateKey,createPublicKey} from 'crypto';
import {ServiceUnavailableException} from '@nestjs/common';
import {signPrivateRequest,readPrivateResponse,PrivateResponse} from '@crimfig/shared';
export class PaystackBrokerClient {
  assertConfigured(){
    let url:URL;
    try{url=new URL(process.env.FINANCIAL_AUTHORITY_URL||'');}catch{throw new ServiceUnavailableException({code:'PROVIDER_GATEWAY_NOT_CONFIGURED',message:'Payment gateway is not configured.'});}
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new ServiceUnavailableException({code:'PROVIDER_GATEWAY_NOT_CONFIGURED',message:'Payment gateway is not configured.'});
    const key=process.env.BILLING_FINANCIAL_WORKLOAD_PRIVATE_KEY,keyId=process.env.BILLING_FINANCIAL_WORKLOAD_KEY_ID;
    try{if(!key||!keyId||!keyId.trim()||keyId.length>200||createPrivateKey(key).asymmetricKeyType!=='ed25519')throw Error();}
    catch{throw new ServiceUnavailableException({code:'PROVIDER_WORKLOAD_NOT_CONFIGURED',message:'Payment gateway identity is not configured.'});}
    let publicKeys:Record<string,string>;
    try{publicKeys=JSON.parse(process.env.FINANCIAL_AUTHORITY_PUBLIC_KEYS||'{}');if(!publicKeys||Array.isArray(publicKeys)||typeof publicKeys!=='object'||!Object.keys(publicKeys).length||Object.entries(publicKeys).some(([id,key])=>!id||typeof key!=='string'||createPublicKey(key).asymmetricKeyType!=='ed25519'))throw Error();}
    catch{throw new ServiceUnavailableException({code:'PROVIDER_RECEIPT_KEYS_NOT_CONFIGURED',message:'Payment gateway verification is not configured.'});}
    return {origin:url.origin,key:key!,keyId:keyId!,publicKeys};
  }
  private async call(path:string,body:unknown):Promise<any>{
    const config=this.assertConfigured();
    const request=signPrivateRequest(path,body,config.keyId,config.key);
    let response:Response;
    try{response=await fetch(`${config.origin}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});}
    catch{throw new ServiceUnavailableException({code:'PROVIDER_GATEWAY_UNAVAILABLE',message:'Payment gateway is temporarily unavailable.'});}
    if(!response.ok)throw new ServiceUnavailableException({code:'PROVIDER_GATEWAY_UNAVAILABLE',message:'Payment gateway is temporarily unavailable.'});
    try{return readPrivateResponse(await response.json() as PrivateResponse,request,config.publicKeys);}
    catch{throw new ServiceUnavailableException({code:'PROVIDER_GATEWAY_RECEIPT_UNCONFIRMED',message:'Payment gateway response could not be verified.'});}
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
