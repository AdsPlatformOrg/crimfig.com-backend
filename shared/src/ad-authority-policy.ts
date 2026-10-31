import {createHash,createHmac,timingSafeEqual} from 'crypto';
export const AD_AUTHORITY_VERSION='opportunity-v1';
export const EVENT_WINDOW_MS=15*60*1000;
export const INGEST_TOLERANCE_MS=60*1000;
export const NANO_CENT=10000000n;
export function stableAdValue(v:any):any {if(v instanceof Date)return v.toISOString();if(typeof v==='bigint')return v.toString();if(Array.isArray(v))return v.map(stableAdValue);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stableAdValue(v[k])]));return v;}
export const adDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(stableAdValue(v))).digest('hex');
/** Old verification keys remain addressable by ID during rotation; never guess a different key. */
export function evidenceKey(keyId:string,env=process.env):string {
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(keyId))throw new Error('Invalid evidence key ID');
  let ring:Record<string,string>={};
  if(env.ADS_EVIDENCE_VERIFICATION_KEYS){try{ring=JSON.parse(env.ADS_EVIDENCE_VERIFICATION_KEYS);}catch{throw new Error('Invalid evidence verification keyring');}}
  const current=env.ADS_EVIDENCE_HASH_KEY_ID||'evidence-v1';
  const key=keyId===current?env.ADS_EVIDENCE_HASH_SECRET:ring[keyId];
  if(typeof key!=='string'||Buffer.byteLength(key)<32)throw new Error('A dedicated evidence signing key is required');return key;
}
export function evidenceSignature(v:unknown,env=process.env){const keyId=(v as any)?.keyId||env.ADS_EVIDENCE_HASH_KEY_ID||'evidence-v1';return createHmac('sha256',evidenceKey(keyId,env)).update(JSON.stringify(stableAdValue(v))).digest('hex');}
export function validEvidenceSignature(value:unknown,signature:string,env=process.env){try{const expected=evidenceSignature(value,env);return /^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex'));}catch{return false;}}
export interface ApprovedAdPolicy {version:string;approvedBy:string;approvedAt:string;pricing:'second_price';bidderGrouping:'advertiser'|'campaign';floors:'bid_and_clearing';eventWindowMs:number;ingestionToleranceMs:number;fractionalClosure:'write_off_subcent';pctrBasisPoints:150;}
export function approvedAdPolicy(env=process.env):ApprovedAdPolicy|null {
  try{const p=JSON.parse(env.ADS_AUCTION_POLICY_APPROVAL||'null');if(!p||typeof p.version!=='string'||p.version.length>64||!p.version.trim()||typeof p.approvedBy!=='string'||!p.approvedBy.trim()||!Number.isFinite(Date.parse(p.approvedAt))||Date.parse(p.approvedAt)>Date.now()||p.fractionalClosure!=='write_off_subcent'||p.pctrBasisPoints!==150||p.pricing!=='second_price'||!['advertiser','campaign'].includes(p.bidderGrouping)||p.floors!=='bid_and_clearing'||p.eventWindowMs!==EVENT_WINDOW_MS||p.ingestionToleranceMs!==INGEST_TOLERANCE_MS)return null;return p;}catch{return null;}
}
