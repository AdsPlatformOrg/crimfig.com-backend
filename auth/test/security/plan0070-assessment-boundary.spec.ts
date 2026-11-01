import {EvidenceService} from '../../../api/ads-api/src/modules/delivery/evidence.service';
import {PgDialect} from 'drizzle-orm/pg-core';

describe('PLAN-0070 fraud cutoff serialization',()=>{
 const key=process.env.ADS_EVIDENCE_HASH_SECRET;
 beforeEach(()=>{process.env.ADS_EVIDENCE_HASH_SECRET='unit-only-house-assessment-key-at-least-32';});
 afterEach(()=>{if(key===undefined)delete process.env.ADS_EVIDENCE_HASH_SECRET;else process.env.ADS_EVIDENCE_HASH_SECRET=key;});
 function fixture(inventoryClass:string){
  const event={id:'event',serveId:'serve',promoterId:'promoter',financialEligibility:'invalid'},serve={id:'serve',campaignId:null,inventoryClass,opportunityReservationId:null};
  const results=[[event],[serve],[],[],[event],[serve]],commands:string[]=[];let inserted:any;
  const chain=(value:any)=>{const q:any={then:(yes:any,no:any)=>Promise.resolve(value).then(yes,no)};for(const k of ['from','where','limit','orderBy','for'])q[k]=()=>q;return q;};
  const db:any={select:()=>chain(results.shift()??[]),execute:async(q:any)=>{const sql=new PgDialect().sqlToQuery(q).sql;commands.push(sql);return {rows:sql.includes('clock_timestamp')?[{now:new Date('2026-11-01T00:00:00Z')}]:[]};},insert:()=>({values:(value:any)=>{inserted=value;return {returning:async()=>[value]};}})};
  db.transaction=async(fn:any)=>fn(db);const service=new EvidenceService(db,{} as any);(service as any).analyze=async()=>({inventoryClass,integrity:true});return {service,commands,inserted:()=>inserted};
 }
 const input={requestId:'00000000-0000-4000-8000-000000000001',outcome:'invalid' as const,reasonCodes:['INVALID_TRAFFIC'],policyVersion:'test-v1'};
 it('House invalidation takes the finalizer lock before request lock and records a post-lock clock',async()=>{
  const h=fixture('house');await h.service.assess('event','reviewer',input);
  expect(h.commands.findIndex(q=>q.includes('cfig:global-allocation'))).toBeLessThan(h.commands.findIndex(q=>q.includes('clock_timestamp')));
  expect(h.inserted().createdAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
 });
 it('paid assessment does not acquire the House lock or change its timestamp path',async()=>{
  const h=fixture('paid');await h.service.assess('event','reviewer',input);
  expect(h.commands.some(q=>q.includes('cfig:global-allocation'))).toBe(false);expect(h.inserted().createdAt).toBeUndefined();
 });
});
