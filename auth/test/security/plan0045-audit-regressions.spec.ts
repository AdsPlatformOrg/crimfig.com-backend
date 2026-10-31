process.env.DB_HOST ||= '127.0.0.1';process.env.DB_NAME ||= 'crimfig_test';process.env.DB_USER ||= 'postgres';process.env.DB_PASSWORD ||= 'postgres';
process.env.JWT_ACCESS_SECRET ||= 'unit-access-secret';process.env.JWT_REFRESH_SECRET ||= 'unit-refresh-secret';process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';process.env.BREVO_API_KEY ||= 'unit-brevo-key';process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';
import {HttpErrorMonitorSink,redactAndSanitizeErrorEvent} from '@crimfig/shared';
import {ErrorMonitorService} from '../../src/modules/error-monitor/error-monitor.service';
import {ErrorMonitorWorker} from '../../src/modules/error-monitor/error-monitor.worker';
import {ErrorMonitorIngestionController} from '../../src/modules/error-monitor/error-monitor.controller';
import {PgDialect} from 'drizzle-orm/pg-core';
const env={NODE_ENV:'test',ERROR_MONITOR_CAPTURE_ENABLED:'true',ERROR_MONITOR_EMAIL_ENABLED:'true',ERROR_MONITOR_INGEST_URL:'https://auth.example/api/v1/internal/error-monitor/events',ERROR_MONITOR_INTERNAL_KEY:'unit-internal-key'};
const event=()=>redactAndSanitizeErrorEvent({service:'ads-api',source:'server',httpMethod:'POST',route:'/campaigns/:id',statusCode:503,requestId:'11111111-1111-4111-8111-111111111111'},env);
describe('PLAN-0045 monitor wiring and outbox regressions — failures first',()=>{
  it('browser reports cannot impersonate backend service identities or reach persistence',async()=>{
    const monitor:any={ingestRawEvent:jest.fn()};const controller=new ErrorMonitorIngestionController(monitor);
    for(const service of ['ads-api','billing-api','auth-api','unregistered-web'])await expect(controller.ingestBrowserEvent({user:{sub:'owner'}},{service,route:'/campaigns'})).rejects.toThrow('registered browser');
    expect(monitor.ingestRawEvent).not.toHaveBeenCalled();
  });
  it('rejects missing credentials, credentials in URLs, redirects and invalid transport URLs before sending',async()=>{
    const send=jest.fn();
    for(const patch of [{ERROR_MONITOR_INTERNAL_KEY:'',INTERNAL_ECOSYSTEM_KEY:''},{ERROR_MONITOR_INGEST_URL:'http://external.example/api/v1/internal/error-monitor/events'},
      {ERROR_MONITOR_INGEST_URL:'https://user:password@auth.example/api/v1/internal/error-monitor/events'}, {ERROR_MONITOR_INGEST_URL:'https://auth.example/other'},
      {ERROR_MONITOR_INGEST_URL:'https://auth.example/api/v1/internal/error-monitor/events?key=secret'}]) {
      await expect(new HttpErrorMonitorSink({...env,...patch},send).recordEvent(event())).rejects.toThrow();
    }expect(send).not.toHaveBeenCalled();
  });
  it('does not report success for rejected, malformed or unavailable ingestion and does not expose provider errors',async()=>{
    for(const response of [new Response('SECRET',{status:503}),new Response('not JSON',{status:202}),new Response(JSON.stringify({status:'error'}),{status:200}),new Response(JSON.stringify({status:'accepted',data:{recorded:false}}),{status:202})]) {
      await expect(new HttpErrorMonitorSink(env,jest.fn(async()=>response)).recordEvent(event())).rejects.toThrow(/ingestion/);
    }
    const failure=await new HttpErrorMonitorSink(env,jest.fn(async()=>{throw Error('SECRET internal URL token');})).recordEvent(event()).catch(e=>e);
    expect(failure.message).toBe('Error monitor transport failed');expect(failure.message).not.toContain('SECRET');
  });
  it('email disable switch prevents reading, leasing or sending even for already queued work',async()=>{
    const db:any={select:jest.fn()},email:any={sendErrorAlertEmail:jest.fn()};const service=new ErrorMonitorService(db,email);
    await expect(service.processDueOutbox(new Date(),10,{...env,ERROR_MONITOR_EMAIL_ENABLED:'false'})).resolves.toEqual({processedCount:0,results:[]});
    expect(db.select).not.toHaveBeenCalled();expect(email.sendErrorAlertEmail).not.toHaveBeenCalled();
  });
  it('a lost outbox lease cannot send an email or mark success',async()=>{
    const item={id:'outbox',attempts:0,maxAttempts:4};
    const q:any={from:()=>q,where:()=>q,orderBy:()=>q,limit:async()=>[item]};
    const db:any={select:()=>q,update:()=>({set:()=>({where:()=>({returning:async()=>[]})})})};
    const email:any={sendErrorAlertEmail:jest.fn()};const service=new ErrorMonitorService(db,email);
    expect((await service.processDueOutbox(new Date(),10,env)).processedCount).toBe(0);expect(email.sendErrorAlertEmail).not.toHaveBeenCalled();
  });
  it('a worker that loses its lease while awaiting the provider cannot overwrite the new owner or mark a group sent',async()=>{
    let reads=0;const groups:any[]=[];
    const item={id:'outbox',groupId:'group',kind:'initial',attempts:0,maxAttempts:4,recipients:['unit@example.com'],subject:'Safe',htmlBody:'Safe'};
    const q:any={from:()=>q,where:()=>q,orderBy:()=>q,limit:async()=>[item]};
    const db:any={select:()=>q,update:(table:any)=>({set:()=>{if(table[Symbol.for('drizzle:Name')]==='error_monitor_groups')groups.push('updated');return {where:()=>({returning:async()=>reads++===0?[{...item,attempts:1}]:[]})};}})};
    const email:any={sendErrorAlertEmail:jest.fn(async()=>({accepted:true,providerMessageId:'accepted-after-lease-loss'}))};
    const result=await new ErrorMonitorService(db,email).processDueOutbox(new Date(),10,env);
    expect(result.processedCount).toBe(0);expect(groups).toHaveLength(0);
  });
  it('worker remains off unless explicitly enabled and configured',()=>{
    jest.useFakeTimers();const previous={...process.env};try{
      process.env.ERROR_MONITOR_OUTBOX_WORKER_ENABLED='false';const service:any={processDueOutbox:jest.fn()};const worker=new ErrorMonitorWorker(service);
      worker.onModuleInit();jest.advanceTimersByTime(60000);expect(service.processDueOutbox).not.toHaveBeenCalled();worker.onModuleDestroy();
    }finally{process.env=previous;jest.useRealTimers();}
  });
  it('forwards the normalized route and safe correlation fields with server credentials and no redirects',async()=>{
    const send=jest.fn(async(_url:any,_init:any)=>new Response(JSON.stringify({status:'accepted',data:{recorded:true}}),{status:202}));
    await new HttpErrorMonitorSink(env,send).recordEvent(event());
    expect(send).toHaveBeenCalledTimes(1);const [url,init]=send.mock.calls[0];expect(url).toBe(env.ERROR_MONITOR_INGEST_URL);
    expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');expect(init.headers['x-internal-key']).toBe('unit-internal-key');
    const body=JSON.parse(init.body);expect(body.route).toBe('/campaigns/:id');expect(body).not.toHaveProperty('normalizedRoute');expect(body).not.toHaveProperty('fingerprint');
    expect(body.requestId).toBe(event().requestId);
  });
  it('reclaims expired processing work with bounded attempts and records provider acceptance',async()=>{
    const predicates:any[]=[],patches:any[]=[];
    const item={id:'outbox',groupId:'group',kind:'initial',status:'processing',attempts:1,maxAttempts:4,recipients:['unit@example.com'],subject:'Failure',htmlBody:'Safe',textBody:'Safe'};
    const q:any={from:()=>q,where:(p:any)=>{predicates.push(p);return q;},orderBy:()=>q,limit:async()=>[item]};
    let first=true;
    const db:any={select:()=>q,update:()=>({set:(patch:any)=>{patches.push(patch);return {where:(p:any)=>{predicates.push(p);const res:any={returning:async()=>first?(first=false,[{...item,attempts:2}]):[{id:item.id}]};res.then=(resolve:any)=>Promise.resolve().then(resolve);return res;}};}})};
    const email:any={sendErrorAlertEmail:jest.fn(async()=>({accepted:true,providerMessageId:'provider-message'}))};
    const result=await new ErrorMonitorService(db,email).processDueOutbox(new Date(),10,env);
    expect(result.processedCount).toBe(1);expect(patches.some(p=>p.status==='provider_accepted'&&p.attempts===2)).toBe(true);
    const sql=new PgDialect().sqlToQuery(predicates[0]);expect(sql.params).toContain('processing');expect(sql.sql).toContain('attempts');expect(sql.sql).toContain('lease_expires_at');
  });
  it('worker prevents overlapping dispatches and clears its timer on shutdown',async()=>{
    jest.useFakeTimers();const previous={...process.env};let complete!:()=>void;
    try{Object.assign(process.env,env,{ERROR_MONITOR_OUTBOX_WORKER_ENABLED:'true'});
      const pending=new Promise<void>(r=>{complete=r;});const service:any={processDueOutbox:jest.fn(()=>pending)};const worker=new ErrorMonitorWorker(service);
      worker.onModuleInit();jest.advanceTimersByTime(60000);expect(service.processDueOutbox).toHaveBeenCalledTimes(1);
      complete();await Promise.resolve();worker.onModuleDestroy();jest.advanceTimersByTime(60000);expect(service.processDueOutbox).toHaveBeenCalledTimes(1);
    }finally{complete?.();process.env=previous;jest.useRealTimers();}
  });
});
