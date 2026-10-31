import {sql} from 'drizzle-orm';
import {randomUUID} from 'crypto';
import {adDigest,evidenceSignature,stableAdValue} from './ad-authority-policy';
/** Caller owns the transaction: event/decision persistence and its journal commit together. */
export async function appendAdEvidence(tx:any,eventId:string,payload:Record<string,unknown>,env=process.env){
  const partition=`ads:${new Date().toISOString().slice(0,10)}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${partition},0))`);
  const result=await tx.execute(sql`SELECT id,payload,record_hash FROM ads_evidence_records WHERE event_id=${eventId}`);const prior=result.rows[0];
  const clean=stableAdValue(payload);
  if(prior){if(adDigest(prior.payload)!==adDigest(clean))throw new Error('Evidence identity changed');return {id:prior.id,recordHash:prior.record_hash};}
  const tail=await tx.execute(sql`SELECT record_hash FROM ads_evidence_records WHERE partition=${partition} ORDER BY sequence DESC LIMIT 1`);
  const previousHash=tail.rows[0]?.record_hash??null,keyId=env.ADS_EVIDENCE_HASH_KEY_ID||'evidence-v1',id=randomUUID();
  const recordHash=evidenceSignature({eventId,partition,previousHash,payload:clean,keyId},env);
  await tx.execute(sql`INSERT INTO ads_evidence_records(id,event_id,partition,payload,previous_hash,record_hash,key_id) VALUES(${id},${eventId},${partition},${JSON.stringify(clean)}::jsonb,${previousHash},${recordHash},${keyId})`);
  return {id,recordHash};
}

/** Compare signed original observations with their projection; isValid is a separately mutable legacy disposition. */
export function adEventJournalMatches(event:any,journal:any):boolean {
  const payload=journal?.payload;
  if(!payload||journal.eventId!==event.id||payload.eventId!==event.eventId||payload.serveId!==event.serveId||payload.type!==event.type||payload.serverReceivedAt!==event.createdAt?.toISOString())return false;
  return ['visibleRatio','durationMs','measurable','assessmentStatus','financialEligibility','verificationVersion','keyedIpHash','keyId','websiteId','slotId'].every(k=>(payload[k]??null)===(event[k]??null));
}
