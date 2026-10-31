import {BadRequestException,ConflictException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {and,desc,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'crypto';
import * as s from '@crimfig/database/schema';
import {adEventJournalMatches,appendAdEvidence,adDigest,evidenceSignature,stableAdValue,validEvidenceSignature} from '@crimfig/shared';
import {paidDeliveryReadiness} from './paid-delivery-policy';
import {OpportunityClient} from '../billing/opportunity-client';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class EvidenceService {
  constructor(@Inject('DATABASE_CONNECTION')private readonly db:any,private readonly opportunity:OpportunityClient){}
  private signingEnv() {
    const rawSecret = process.env.ADS_EVIDENCE_HASH_SECRET;
    if (!rawSecret || Buffer.byteLength(rawSecret) < 32) {
      throw new ServiceUnavailableException('Dedicated ad evidence signing is not configured');
    }
    const keyId = process.env.ADS_EVIDENCE_HASH_KEY_ID || 'evidence-v1';
    return {
      ...process.env,
      ADS_EVIDENCE_HASH_KEY_ID: keyId,
      ADS_EVIDENCE_HASH_SECRET: rawSecret,
    };
  }
  async append(eventId:string,payload:Record<string,unknown>,existingTx?:any){
    const write=(tx:any)=>appendAdEvidence(tx,eventId,payload,this.signingEnv());
    return existingTx?write(existingTx):this.db.transaction(write);
  }
  async controls(scope:string,targetId:string){return this.db.select().from(s.adsTrafficControls).where(and(eq(s.adsTrafficControls.targetScope,scope),eq(s.adsTrafficControls.targetId,targetId))).orderBy(desc(s.adsTrafficControls.createdAt)).limit(100);}
  async control(actorId:string,input:{requestId:string;targetScope:'slot'|'website'|'promoter'|'campaign';targetId:string;action:string;active:boolean;reasonCode:string;internalNote:string;expiresAt:string}){
    const expiry=new Date(input.expiresAt);
    if(!uuid.test(input.requestId)||!uuid.test(input.targetId)||!['slot','website','promoter','campaign'].includes(input.targetScope)||!['SHADOW_SLOT','QUARANTINE_TRAFFIC','PAUSE_PAID_DELIVERY'].includes(input.action)||!Number.isFinite(expiry.getTime())||expiry<=new Date()||expiry.getTime()>Date.now()+30*86400000||!/^[A-Z0-9_]{2,64}$/.test(input.reasonCode)||!input.internalNote.trim()||input.internalNote.length>2000)throw new BadRequestException('A scoped control, evidence reason and review expiry within 30 days are required');
    return this.db.transaction(async(tx:any)=>{
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`traffic-control-request:${input.requestId}`},0))`);
      const table={slot:s.adstationSlots,website:s.adsPromoterWebsites,promoter:s.adsPromoters,campaign:s.adsCampaigns}[input.targetScope];
      const [target]=await tx.select().from(table).where(eq(table.id,input.targetId)).for('update').limit(1);if(!target)throw new NotFoundException('Control target not found');
      const [prior]=await tx.select().from(s.adsSupplyStateHistory).where(eq(s.adsSupplyStateHistory.requestId,input.requestId)).limit(1);
      const reason=JSON.stringify({fingerprint:adDigest(input),code:input.reasonCode,note:input.internalNote});
      if(prior){if(prior.actorId!==actorId||prior.reason!==reason)throw new ConflictException('Control request identity changed');return {replayed:true};}
      await tx.update(s.adsTrafficControls).set({isActive:false,updatedAt:new Date()}).where(and(eq(s.adsTrafficControls.targetScope,input.targetScope),eq(s.adsTrafficControls.targetId,input.targetId),eq(s.adsTrafficControls.action,input.action),eq(s.adsTrafficControls.isActive,true)));
      if(input.active)await tx.insert(s.adsTrafficControls).values({targetScope:input.targetScope,targetId:input.targetId,action:input.action,isActive:true,reasonCode:input.reasonCode,internalNote:input.internalNote,createdBy:actorId,expiresAt:expiry});
      await tx.insert(s.adsSupplyStateHistory).values({entityType:input.targetScope,entityId:input.targetId,dimension:'traffic_control',toState:input.active?'restricted':'released',actorId,actorRole:'super_admin',requestId:input.requestId,reason});
      return {replayed:false,active:input.active,expiresAt:expiry};
    });
  }
  async health(){
    const result=await this.db.execute(sql`SELECT (SELECT count(*)::int FROM ads_opportunity_reservations WHERE NOT is_simulated AND state='CLAIMED' AND settled_at IS NULL) AS retained_claims,
      (SELECT count(*)::int FROM ads_interactions e JOIN ads_serves v ON v.id=e.serve_id WHERE v.inventory_class='paid' AND NOT EXISTS(SELECT 1 FROM ads_event_assessments a WHERE a.event_id=e.id)) AS unassessed_events,
      (SELECT max(created_at) FROM ads_evidence_records) AS latest_evidence_at,
      (SELECT count(*)::int FROM ads_traffic_controls WHERE is_active AND expires_at>now()) AS active_controls`);return {...(result.rows??result)[0],paidDelivery:paidDeliveryReadiness()};
  }
  /** Pull-based export for an independently operated append-only archiver. No independent storage is implied by returning this envelope. */
  async checkpoint(partition:string){
    if(!/^ads:\d{4}-\d{2}-\d{2}$/.test(partition))throw new BadRequestException('A UTC evidence partition is required');
    const rows=await this.db.execute(sql`SELECT sequence,record_hash,created_at FROM ads_evidence_records WHERE partition=${partition} ORDER BY sequence DESC LIMIT 1`);
    const tail=rows.rows[0];if(!tail)throw new NotFoundException('Evidence partition not found');
    const envelope={version:1,partition,throughSequence:tail.sequence,recordHash:tail.record_hash,recordedAt:tail.created_at,keyId:process.env.ADS_EVIDENCE_HASH_KEY_ID||'evidence-v1'};
    return {envelope,signature:evidenceSignature(envelope),archiveState:'external_receipt_required'};
  }
  async analyze(eventId:string){
    const [event]=await this.db.select().from(s.adsInteractions).where(eq(s.adsInteractions.id,eventId)).limit(1);if(!event)throw new NotFoundException('Evidence event not found');
    const [serve]=event.serveId?await this.db.select().from(s.adsServes).where(eq(s.adsServes.id,event.serveId)).limit(1):[];
    const [journal]=await this.db.select().from(s.adsEvidenceRecords).where(eq(s.adsEvidenceRecords.eventId,eventId)).limit(1);
    let integrity=false;if(journal){const {eventId,partition,previousHash,payload,keyId}=journal;try{integrity=evidenceSignature({eventId,partition,previousHash,payload,keyId},this.signingEnv())===journal.recordHash;}catch{integrity=false;}}
    let chainLinkIntegrity=false;
    if(journal){const previous=await this.db.execute(sql`SELECT record_hash FROM ads_evidence_records WHERE partition=${journal.partition} AND sequence<${journal.sequence} ORDER BY sequence DESC LIMIT 1`);chainLinkIntegrity=(previous.rows[0]?.record_hash??null)===journal.previousHash;}
    integrity=integrity&&chainLinkIntegrity&&adEventJournalMatches(event,journal);
    const duplicates=await this.db.execute(sql`SELECT type,count(*)::int AS count FROM ads_interactions WHERE serve_id=${event.serveId} GROUP BY type`);
    return {eventId,serveId:event.serveId,inventoryClass:serve?.inventoryClass??'unknown',integrity,chainLinkIntegrity,
      signals:{type:event.type,serverReceivedAt:event.createdAt,visibleRatio:event.visibleRatio,durationMs:event.durationMs,measurable:event.measurable,
        preliminaryAssessment:event.assessmentStatus,preliminaryIvt:event.ivtCategory,financialEligibility:serve?.inventoryClass==='paid'?'pending':'invalid',
        keyedIpHash:event.keyedIpHash,keyId:event.keyId,duplicateCounts:duplicates.rows??duplicates},
      warning:'Client observations and fast-path classifications are evidence, not proof of authentic traffic.'};
  }
  async assess(eventId:string,actorId:string,input:{requestId:string;outcome:'eligible'|'quarantined'|'invalid';reasonCodes:string[];policyVersion:string;supersedesId?:string}){
    if(!uuid.test(input.requestId)||!['eligible','quarantined','invalid'].includes(input.outcome)||!Array.isArray(input.reasonCodes)||!input.reasonCodes.length||input.reasonCodes.length>20||input.reasonCodes.some(r=>!/^[A-Z0-9_]{2,64}$/.test(r))||!input.policyVersion||input.policyVersion.length>64)throw new BadRequestException('A bounded assessment policy and reasons are required');
    const analysis=await this.analyze(eventId);
    const outcome=await this.db.transaction(async(tx:any)=>{
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ad-assessment:${input.requestId}`},0))`);
      const [event]=await tx.select().from(s.adsInteractions).where(eq(s.adsInteractions.id,eventId)).limit(1);
      const [serve]=event?.serveId?await tx.select().from(s.adsServes).where(eq(s.adsServes.id,event.serveId)).limit(1):[];
      if(!serve)throw new ConflictException('An issued serve is required');
      if(serve.campaignId){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${serve.campaignId}`},0))`);
        const [campaign]=await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id,serve.campaignId)).for('update').limit(1);
        const [promoter]=await tx.select().from(s.adsPromoters).where(eq(s.adsPromoters.id,event.promoterId)).limit(1);
        if(campaign.advertiserId===actorId||promoter?.userId===actorId)throw new ConflictException('Owners cannot assess their own financial traffic');}
      const [priorRequest]=await tx.select().from(s.adsEventAssessments).where(eq(s.adsEventAssessments.requestId,input.requestId)).limit(1);
      if(priorRequest){if(priorRequest.eventId!==eventId||priorRequest.actorId!==actorId||priorRequest.outcome!==input.outcome||adDigest(priorRequest.reasonCodes)!==adDigest(input.reasonCodes)||priorRequest.policyVersion!==input.policyVersion||(priorRequest.supersedesId??null)!==(input.supersedesId??null))throw new ConflictException('Assessment request identity changed');return priorRequest;}
      const [previous]=await tx.select().from(s.adsEventAssessments).where(eq(s.adsEventAssessments.eventId,eventId)).orderBy(desc(s.adsEventAssessments.createdAt),desc(s.adsEventAssessments.id)).limit(1);
      if((previous?.id??null)!==(input.supersedesId??null))throw new ConflictException('The assessment changed. Reload before classifying');
      const [funded]=serve.opportunityReservationId?await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,serve.opportunityReservationId)).for('update').limit(1):[];
      if(funded?.settledAt)throw new ConflictException('Claimed traffic requires the formal Billing rejection/reversal workflow');
      if(input.outcome==='eligible'&&(!process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION||input.policyVersion!==process.env.ADS_TRAFFIC_ASSESSMENT_POLICY_VERSION||!analysis.integrity||serve.inventoryClass!=='paid'||!funded||!['ISSUED','CLAIMED'].includes(funded.state)||event.financialEligibility==='invalid'||event.assessmentStatus==='invalidated'))throw new ConflictException('This evidence cannot authorize a payable event');
      const signed={id:randomUUID(),eventId,campaignId:serve.campaignId,requestId:input.requestId,actorId,policyVersion:input.policyVersion,outcome:input.outcome,reasonCodes:input.reasonCodes,
        features:{evidenceDigest:adDigest(analysis),integrity:analysis.integrity},supersedesId:previous?.id??null,keyId:process.env.ADS_EVIDENCE_HASH_KEY_ID||'evidence-v1'};
      const [assessment]=await tx.insert(s.adsEventAssessments).values({...signed,recordHash:evidenceSignature(signed)}).returning();return assessment;
    });
    // A crash here leaves a durable eligible assessment for the Billing reconciler; it never fabricates a claim.
    if(outcome.outcome==='eligible'||outcome.outcome==='invalid'){
      const [event]=await this.db.select().from(s.adsInteractions).where(eq(s.adsInteractions.id,eventId)).limit(1);
      const [serve]=await this.db.select().from(s.adsServes).where(eq(s.adsServes.id,event.serveId)).limit(1);
      if(serve.opportunityReservationId){if(outcome.outcome==='eligible')await this.opportunity.claim(serve.opportunityReservationId,eventId);else await this.opportunity.reject(serve.opportunityReservationId,eventId);}
    }
    return {id:outcome.id,eventId,outcome:outcome.outcome,policyVersion:outcome.policyVersion};
  }
}
