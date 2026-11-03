/** Public first-party destinations use deployment scope, never request headers/return parameters. */
export function publicAppOrigin(app:'auth'|'ads'|'billing',configured?:string,env:Record<string,string|undefined>=process.env):string{
 const scope=env.RAILWAY_ENVIRONMENT_NAME||(env.NODE_ENV==='staging'?'staging':env.NODE_ENV==='production'?'production':'local');
 const expected=scope==='staging'?`https://staging-${app}.crimfig.com`:scope==='production'?`https://${app}.crimfig.com`:null;
 const fallback=expected||`http://localhost:${app==='auth'?3000:app==='ads'?3005:3007}`;
 let url:URL;try{url=new URL(configured||fallback);}catch{throw Error(`${app} public origin is invalid`);}
 const local=scope!=='staging'&&scope!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(!local&&url.protocol!=='https:')||(expected&&url.origin!==expected))throw Error(`${app} public origin conflicts with deployment scope`);
 return url.origin;
}

/** Public Ads API may use a Railway hostname; opaque custom service bindings require deployment review. */
export function adsPublicOrigin(env:Record<string,string|undefined>=process.env):string{
 const staging=env.RAILWAY_ENVIRONMENT_NAME==='staging'||env.APP_ENV==='staging';
 if(staging&&!env.ADS_PUBLIC_URL)throw Error('Explicit staging ADS_PUBLIC_URL is required');
 let url:URL;try{url=new URL(env.ADS_PUBLIC_URL||'https://ads.crimfig.com');}catch{throw Error('Ads public API origin is invalid');}
 const local=env.NODE_ENV!=='production'&&!staging&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||(!local&&url.protocol!=='https:')||(staging&&(/(^|[-.])production([-.]|$)/i.test(url.hostname)||url.hostname==='ads.crimfig.com'||url.hostname.includes('.staging.'))))throw Error('Ads public API origin conflicts with deployment scope');
 return url.origin;
}

export function authIssuer(env:Record<string,string|undefined>=process.env):string{
 if((env.RAILWAY_ENVIRONMENT_NAME==='staging'||env.NODE_ENV==='staging')&&!env.OAUTH_ISSUER)throw Error('Explicit staging OAUTH_ISSUER is required; issuer changes require owner review');
 // Keep the historical production issuer default outside staging; never rotate it as a navigation fix.
 if(!env.OAUTH_ISSUER)return 'https://auth.crimfig.com';
 return publicAppOrigin('auth',env.OAUTH_ISSUER,env);
}

/** Registered external OAuth clients retain their contract; owned app callbacks stay in scope. */
export function firstPartyReturnAllowed(callback:URL,env:Record<string,string|undefined>=process.env):boolean{
 const match=/^(?:staging-)?(auth|ads|billing)(?:\.staging)?\.crimfig\.com$/.exec(callback.hostname);
 if(!match)return true;
 return callback.origin===publicAppOrigin(match[1] as 'auth'|'ads'|'billing',undefined,env);
}
