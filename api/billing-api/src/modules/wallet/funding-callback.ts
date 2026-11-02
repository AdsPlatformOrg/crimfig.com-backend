import {BadRequestException,ServiceUnavailableException} from '@nestjs/common';
/** NODE_ENV=production includes optimized staging containers. Explicit deployment scope wins. */
export function fundingCallback(requested?:string):string{
 const environment=process.env.RAILWAY_ENVIRONMENT_NAME;
 const staging=environment==='staging';
 const production=environment==='production'||(!environment&&process.env.NODE_ENV==='production');
 const expected=staging?'https://staging-billing.crimfig.com':production?'https://billing.crimfig.com':null;
 const fallback=expected||'http://localhost:3007';
 let url:URL;
 try{url=new URL(process.env.BILLING_WEB_URL||fallback);}catch{throw new ServiceUnavailableException({code:'FUNDING_RETURN_URL_NOT_CONFIGURED',message:'Payment return URL is not configured safely.'});}
 const local=process.env.NODE_ENV!=='production'&&!staging&&!production&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(!local&&url.protocol!=='https:')||(expected&&url.origin!==expected))throw new ServiceUnavailableException({code:'FUNDING_RETURN_URL_NOT_CONFIGURED',message:'Payment return URL is not configured safely.'});
 if(requested){let candidate:URL;try{candidate=new URL(requested);}catch{throw new BadRequestException('Funding must return to the configured Billing page');}if(candidate.href!==url.href)throw new BadRequestException('Funding must return to the configured Billing page');}
 return url.href;
}
