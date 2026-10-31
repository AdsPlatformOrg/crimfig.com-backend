import {BadRequestException,ConflictException,Inject,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {randomUUID} from 'crypto';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '@crimfig/database/schema';
import {adEventJournalMatches,adDigest,approvedAdPolicy,appendAdEvidence,AD_AUTHORITY_VERSION,EVENT_WINDOW_MS,INGEST_TOLERANCE_MS,NANO_CENT,stableAdValue,validEvidenceSignature} from '@crimfig/shared';
import {currentApproval} from '../../../../ads-api/src/modules/campaigns/campaign-workflow';
import {eventPriceNanos,reservePriceMicrosForModel,auctionScoreMicros} from '../../../../ads-api/src/modules/delivery/pricing-contract';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface OpportunityInput {
  serveBefore:string;opportunityId:string;campaignId:string;creativeId:string;submissionId:string;contentRevision:number;
  promoterId:string;websiteId:string;slotId:string;policyVersion:string;priceNanos:string;clearingPriceMicros:number;
  visitorKey:string;ipHash:string;selectedImageUrl?:string;decision:Record<string,any>;
}

/** Shared-DB financial authority. Never debits a wallet at serve time. All states
 * serialize with campaign escrow and funded settlement using the same lock order.
 */
@Injectable()
export class AdOpportunityService {
  constructor(@Inject('DATABASE_CONNECTION')private readonly db:any){}
  private async lock(tx:any,campaignId:string){
    await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ads-escrow:${campaignId}`},0))`);
    const [c]=await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id,campaignId)).for('update').limit(1);
    if(!c)throw new NotFoundException('Campaign not found');return c;
  }
  private receipt(row:any){return stableAdValue({authorityVersion:appendAdEvidence,AD_AUTHORITY_VERSION,reservationId:row.id,opportunityId:row.opportunityId,
    campaignId:row.campaignId,escrowId:row.escrowId,escrowAllocatedUsdCents:row.escrowAllocatedUsdCents,
    submissionId:row.submissionId,contentRevision:row.contentRevision,creativeId:row.creativeId,serveId:row.serveId,promoterId:row.promoterId,websiteId:row.websiteId,slotId:row.slotId,policyVersion:row.policyVersion,
    state:row.state,priceNanos:row.reservedNanos,eventDeadline:row.eventDeadline,ingestDeadline:row.ingestDeadline,expiresAt:row.expiresAt,bindingFingerprint:row.bindingFingerprint});}
  private async expire(tx:any,id:string){await tx.execute(sql`UPDATE ads_opportunity_reservations SET state='EXPIRED',released_at=now(),release_reason='PAYABLE_WINDOW_CLOSED',updated_at=now()
    WHERE campaign_id=${id} AND is_simulated=false AND settled_at IS NULL AND state IN('HELD','ISSUED') AND expires_at<=now() AND NOT EXISTS(SELECT 1 FROM ads_interactions e WHERE e.serve_id=ads_opportunity_reservations.serve_id AND e.created_at<=ads_opportunity_reservations.event_deadline AND e.financial_eligibility='pending' AND e.verification_version=2 AND e.type=CASE WHEN ads_opportunity_reservations.pricing_model='cpc' THEN 'click' ELSE 'viewable_impression' END)`);}
  private async supply(tx:any,row:any,c:any){
    const [supply]=await tx.select({slot:s.adstationSlots,site:s.adsPromoterWebsites,promoter:s.adsPromoters}).from(s.adstationSlots)
      .innerJoin(s.adsPromoterWebsites,eq(s.adsPromoterWebsites.id,s.adstationSlots.websiteId)).innerJoin(s.adsPromoters,eq(s.adsPromoters.id,s.adstationSlots.promoterId))
      .where(eq(s.adstationSlots.id,row.slotId)).for('share').limit(1);
    if(!supply||!['network','hybrid'].includes(supply.slot.slotType)||supply.site.id!==row.websiteId||supply.promoter.id!==row.promoterId||supply.site.promoterId!==row.promoterId||supply.promoter.userId===c.advertiserId||
      !supply.slot.isActive||supply.slot.lifecycleStatus!=='active'||supply.slot.installationStatus!=='verified'||!supply.site.isActive||supply.site.isSuspended||supply.site.policyStatus!=='approved'||
      supply.site.verificationStatus!=='verified'||!supply.site.verificationExpiresAt||supply.site.verificationExpiresAt<=new Date()||!supply.promoter.isActive||supply.promoter.isSuspended)throw new ConflictException('Supply is not eligible for paid delivery');
    const controls=await tx.execute(sql`SELECT id FROM ads_traffic_controls WHERE is_active AND (expires_at IS NULL OR expires_at>now()) AND
      ((target_scope='slot' AND target_id=${row.slotId}) OR (target_scope='website' AND target_id=${row.websiteId}) OR (target_scope='promoter' AND target_id=${row.promoterId}) OR (target_scope='campaign' AND target_id=${c.id})) LIMIT 1`);
    if((controls.rows??controls).length)throw new ConflictException('Supply is under a traffic restriction');
    const owners=await tx.select({id:s.users.id,status:s.users.status}).from(s.users).where(sql`${s.users.id} IN (${c.advertiserId},${supply.promoter.userId})`).for('share');
    if(owners.length!==2||owners.some((u:any)=>u.status!=='ACTIVE'))throw new ConflictException('Account eligibility changed');return supply;
  }
  async reserve(input:OpportunityInput){
    if(process.env.ADS_PAID_SERVING_ENABLED!=='true'||process.env.ADS_PAID_RELEASE_ENABLED!=='true')throw new ServiceUnavailableException('Paid release is disabled');
    const policy=approvedAdPolicy();if(!policy||policy.version!==input.policyVersion)throw new ServiceUnavailableException('An approved auction policy is required');
    if(![input.opportunityId,input.campaignId,input.creativeId,input.submissionId,input.promoterId,input.websiteId,input.slotId].every(v=>uuid.test(v))||
      !Number.isSafeInteger(input.contentRevision)||input.contentRevision<1||!/^\d{1,24}$/.test(input.priceNanos)||!(/^[a-f0-9]{16}$/).test(input.ipHash)||!/^[a-f0-9]{64}$/.test(input.visitorKey)||JSON.stringify(input.decision).length>250000)throw new BadRequestException('Invalid opportunity binding');
    const deadline=Date.parse(input.serveBefore);if(!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+9500)throw new ConflictException('Opportunity deadline is invalid');
    const binding=adDigest(input),price=BigInt(input.priceNanos);
    const decision=input.decision;
    if(!decision||!Array.isArray(decision.evaluatedCandidates)||!Array.isArray(decision.excludedCandidates)||typeof decision.tieSeed!=='string'||decision.tieSeed.length>256||decision.bidderGroupingMode!==policy.bidderGrouping||String(decision.billingPriceNanos)!==input.priceNanos)throw new ConflictException('Decision pricing policy is inconsistent');
    if(decision.requestId!==input.opportunityId||decision.winnerCampaignId!==input.campaignId||decision.winnerCreativeId!==input.creativeId||decision.clearingPriceMicros!==input.clearingPriceMicros||decision.policyVersion!==input.policyVersion)throw new ConflictException('Decision does not match its opportunity binding');
    return this.db.transaction(async(tx:any)=>{
      const c=await this.lock(tx,input.campaignId);await this.expire(tx,c.id);
      const [prior]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.opportunityId,input.opportunityId)).limit(1);
      if(prior){if(prior.bindingFingerprint!==binding||prior.isSimulated)throw new ConflictException('Opportunity identity changed');return this.receipt(prior);}
      if(c.status!=='active'||!currentApproval(c)||c.currentSubmissionId!==input.submissionId||c.contentRevision!==input.contentRevision||c.pricingVersion!==2||
        c.startsAt&&c.startsAt>new Date()||c.endsAt&&c.endsAt<=new Date())throw new ConflictException('Campaign revision is not serving eligible');
      const supply=await this.supply(tx,input,c);
      const [creative]=await tx.select().from(s.adsCreatives).where(and(eq(s.adsCreatives.id,input.creativeId),eq(s.adsCreatives.campaignId,c.id))).for('share').limit(1);
      const [stack]=creative?await tx.select().from(s.adsCreativeStacks).where(eq(s.adsCreativeStacks.id,creative.adStackId)).for('share').limit(1):[];
      if(!creative||creative.adType==='video'&&process.env.CREATIVE_VIDEO_AUTHORING_ENABLED!=='true'||creative.status!=='active'||creative.reviewStatus!=='approved'||!stack||stack.archived||stack.campaignId!==c.id||supply.slot.format!==creative.adFormat||!JSON.parse(supply.slot.allowedAdTypes||'[]').includes(creative.adType))throw new ConflictException('Creative eligibility changed');
      const [escrow]=await tx.select().from(s.adsCampaignEscrows).where(eq(s.adsCampaignEscrows.campaignId,c.id)).for('update').limit(1);
      if(!escrow||escrow.status!=='active'||escrow.userId!==c.advertiserId)throw new ConflictException('Active funded escrow is required');
      const [proof]=await tx.select().from(s.billingTransactions).where(eq(s.billingTransactions.idempotencyKey,`ads-escrow:v2:${escrow.id}:reserve:${escrow.allocatedUsdCents}`)).limit(1);
      let meta:any;try{meta=JSON.parse(proof?.metadata??'{}');}catch{throw new ConflictException('Funding proof is invalid');}
      if(!proof||proof.status!=='completed'||proof.type!=='internal_debit'||!Number.isSafeInteger(proof.amountUsdCents)||proof.amountUsdCents<=0||proof.provider!=='internal'||meta.version!==2||meta.kind!=='campaign_escrow'||meta.action!=='reserve'||proof.userId!==c.advertiserId||meta.campaignId!==c.id||meta.escrowId!==escrow.id||meta.allocatedUsdCents!==escrow.allocatedUsdCents)throw new ConflictException('Funding proof is unavailable');
      const floor=reservePriceMicrosForModel(c.pricingModel),bid=c.pricingModel==='cpc'?c.costPerClickUsdCents:c.costPerImpressionUsdCents;
      if(price<=0n||!Number.isSafeInteger(input.clearingPriceMicros)||input.clearingPriceMicros<floor||input.clearingPriceMicros>auctionScoreMicros(c.pricingModel,bid)||price!==eventPriceNanos(c.pricingModel,input.clearingPriceMicros))throw new ConflictException('Quote exceeds its funded pricing contract');
      const usage=await tx.execute(sql`SELECT coalesce(sum(reserved_nanos) FILTER(WHERE settled_at IS NULL AND state IN('HELD','ISSUED','CLAIMED') AND escrow_id=${escrow.id} AND escrow_allocated_usd_cents=${escrow.allocatedUsdCents}),0)::text AS outstanding,
        coalesce(sum(reserved_nanos) FILTER(WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AND state IN('HELD','ISSUED','CLAIMED')),0)::text AS daily,
        coalesce(sum(reserved_nanos) FILTER(WHERE created_at>=date_trunc('hour',now()) AND state IN('HELD','ISSUED','CLAIMED')),0)::text AS hourly,
        count(*) FILTER(WHERE visitor_key=${input.visitorKey} AND created_at>=date_trunc('day',now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AND (state='HELD' OR serve_id IS NOT NULL))::int AS frequency
        FROM ads_opportunity_reservations WHERE campaign_id=${c.id} AND is_simulated=false`);
      const u=(usage.rows??usage)[0];
      const carry=await tx.execute(sql`SELECT coalesce(sum(carry_nanos),0)::text AS nanos FROM ads_settlement_carries WHERE escrow_id=${escrow.id} AND allocated_usd_cents=${escrow.allocatedUsdCents}`);
      const remaining=BigInt(Math.min(c.remainingBudgetUsdCents,escrow.allocatedUsdCents-escrow.consumedUsdCents-escrow.refundedUsdCents))*NANO_CENT;
      if(BigInt(u.outstanding)+BigInt((carry.rows??carry)[0].nanos)+price>remaining||c.dailyBudgetUsdCents!=null&&BigInt(u.daily)+price>BigInt(c.dailyBudgetUsdCents)*NANO_CENT||
        c.hourlyPacingUsdCents!=null&&BigInt(u.hourly)+price>BigInt(c.hourlyPacingUsdCents)*NANO_CENT||u.frequency>=c.frequencyCapPerDay)throw new ConflictException('Opportunity capacity is unavailable');
      let artwork=creative.imageUrl;
      if(creative.mediaAssetId){const [asset]=await tx.select().from(s.adsMediaAssets).where(and(eq(s.adsMediaAssets.id,creative.mediaAssetId),eq(s.adsMediaAssets.ownerId,c.advertiserId),eq(s.adsMediaAssets.status,'ready'))).for('share').limit(1);
        if(!asset)throw new ConflictException('Media asset is unavailable');
        if(input.selectedImageUrl){const choices=(asset.preparation as any)?.renditions??[{url:asset.cdnUrl,bytes:asset.bytes}];if(!choices.some((r:any)=>r.url===input.selectedImageUrl&&Number(r.bytes)<=(supply.slot.format==='banner'?100000:300000)))throw new ConflictException('Invalid artwork rendition');artwork=input.selectedImageUrl;}}
      const now=new Date(),eventDeadline=new Date(now.getTime()+EVENT_WINDOW_MS),ingestDeadline=new Date(eventDeadline.getTime()+INGEST_TOLERANCE_MS);
      const [row]=await tx.insert(s.adsOpportunityReservations).values({opportunityId:input.opportunityId,campaignId:c.id,escrowId:escrow.id,escrowAllocatedUsdCents:escrow.allocatedUsdCents,
        creativeId:creative.id,submissionId:input.submissionId,contentRevision:c.contentRevision,promoterId:input.promoterId,websiteId:input.websiteId,slotId:input.slotId,
        bindingFingerprint:binding,reservedNanos:price,reservedUsdCentsCeiling:Number((price+NANO_CENT-1n)/NANO_CENT),pricingModel:c.pricingModel,visitorKey:input.visitorKey,
        policyVersion:policy.version,policySnapshot:{policy,slotPolicyRevision:supply.slot.policyRevision,serveBefore:input.serveBefore,ipHash:input.ipHash,decision:input.decision,render:{...creative,imageUrl:artwork},slotTagId:supply.slot.slotTagId},
        state:'HELD',eventDeadline,ingestDeadline,expiresAt:new Date(now.getTime()+30000),isSimulated:false}).returning();return this.receipt(row);
    });
  }
  async issue(id:string,bindingFingerprint:string){return this.db.transaction(async(tx:any)=>{
    const [initial]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).limit(1);if(!initial)throw new NotFoundException('Opportunity not found');
    const c=await this.lock(tx,initial.campaignId);await this.expire(tx,c.id);
    const [row]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).for('update').limit(1);
    if(row.isSimulated||row.bindingFingerprint!==bindingFingerprint)throw new ConflictException('Opportunity binding changed');
    if(row.serveId){const [serve]=await tx.select().from(s.adsServes).where(eq(s.adsServes.id,row.serveId)).limit(1);return {receipt:this.receipt(row),serveId:serve.id,render:(row.policySnapshot as any).render};}
    if(process.env.ADS_PAID_SERVING_ENABLED!=='true'||process.env.ADS_PAID_RELEASE_ENABLED!=='true')throw new ConflictException('Paid release is disabled');
    if(row.state!=='HELD'||row.expiresAt<=new Date()||!currentApproval(c)||c.status!=='active'||c.contentRevision!==row.contentRevision||c.currentSubmissionId!==row.submissionId||approvedAdPolicy()?.version!==row.policyVersion)throw new ConflictException('Opportunity is no longer issuable');
    const supply=await this.supply(tx,row,c);
    if(supply.slot.policyRevision!==(row.policySnapshot as any).slotPolicyRevision)throw new ConflictException('Slot policy changed');
    const [creative]=await tx.select().from(s.adsCreatives).where(eq(s.adsCreatives.id,row.creativeId)).for('share').limit(1);
    if(!creative||creative.campaignId!==c.id||creative.status!=='active'||creative.reviewStatus!=='approved')throw new ConflictException('Creative eligibility changed');
    if(creative.mediaAssetId){const [asset]=await tx.select().from(s.adsMediaAssets).where(eq(s.adsMediaAssets.id,creative.mediaAssetId)).for('share').limit(1);if(!asset||asset.ownerId!==c.advertiserId||asset.status!=='ready')throw new ConflictException('Media eligibility changed');}

    const snapshot=row.policySnapshot as any,decision=snapshot.decision,serveId=randomUUID();
    if(!Number.isFinite(Date.parse(snapshot.serveBefore))||Date.parse(snapshot.serveBefore)<=Date.now())throw new ConflictException('Opportunity deadline has closed');
    const [audit]=await tx.insert(s.adsAuctionDecisions).values({requestId:row.opportunityId,serveId,promoterId:row.promoterId,websiteId:row.websiteId,slotId:row.slotId,slotTagId:snapshot.slotTagId,
      inventoryClass:'paid',deliveryMode:'normal',trafficRiskStatus:'normal',financialEligibility:'pending',policyVersion:row.policyVersion,bidderGroupingMode:snapshot.policy.bidderGrouping,
      tieSeed:decision.tieSeed,candidateCount:decision.candidateCount,eligibleGroupCount:decision.eligibleGroupCount,evaluatedCandidates:decision.evaluatedCandidates,excludedCandidates:decision.excludedCandidates,
      winnerCampaignId:c.id,winnerCreativeId:row.creativeId,runnerUpCampaignId:decision.runnerUpCampaignId??null,pricingModel:row.pricingModel,clearingPriceMicros:decision.clearingPriceMicros,
      billingPriceNanos:row.reservedNanos,opportunityReservationId:row.id,recordHash:adDigest({bindingFingerprint,row:stableAdValue(row),decision})}).returning();
    await tx.insert(s.adsServes).values({id:serveId,requestId:row.opportunityId,campaignId:c.id,creativeId:row.creativeId,promoterId:row.promoterId,websiteId:row.websiteId,slotId:row.slotId,placementId:null,
      slotHandle:snapshot.slotTagId,inventoryClass:'paid',deliveryMode:'normal',trafficRiskStatus:'normal',financialEligibility:'pending',auctionDecisionId:audit.id,policyVersion:row.policyVersion,
      opportunityReservationId:row.id,submissionId:row.submissionId,contentRevision:row.contentRevision,contentSnapshot:snapshot.render,pricingVersion:2,ipHash:snapshot.ipHash,pricingModel:row.pricingModel,billingPriceNanos:row.reservedNanos,clearingPriceMicros:decision.clearingPriceMicros});
    await appendAdEvidence(tx,row.opportunityId,{version:1,stage:'issued',opportunityId:row.opportunityId,serveId,reservationId:row.id,bindingFingerprint:row.bindingFingerprint,decision,render:snapshot.render,policy:snapshot.policy});
    const [issued]=await tx.update(s.adsOpportunityReservations).set({state:'ISSUED',serveId,eventDeadline:new Date(Date.now()+EVENT_WINDOW_MS),ingestDeadline:new Date(Date.now()+EVENT_WINDOW_MS+INGEST_TOLERANCE_MS),expiresAt:new Date(Date.now()+EVENT_WINDOW_MS+INGEST_TOLERANCE_MS),updatedAt:new Date()}).where(eq(s.adsOpportunityReservations.id,id)).returning();
    if(Date.parse(snapshot.serveBefore)<=Date.now())throw new ConflictException('Opportunity deadline has closed');
    return {receipt:this.receipt(issued),serveId,render:snapshot.render};
  });}
  async read(id:string){const [row]=await this.db.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).limit(1);if(!row)throw new NotFoundException('Opportunity not found');return this.receipt(row);}
  async release(id:string,reason:string){return this.db.transaction(async(tx:any)=>{
    const [row]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).limit(1);if(!row)throw new NotFoundException('Opportunity not found');await this.lock(tx,row.campaignId);await this.expire(tx,row.campaignId);
    const [current]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).for('update').limit(1);
    if(current.state==='CLAIMED')throw new ConflictException('Claimed exposure must settle or use formal rejection');
    if(current.state==='ISSUED')throw new ConflictException('An issued token is still payable');
    if(['RELEASED','EXPIRED'].includes(current.state))return this.receipt(current);
    const [released]=await tx.update(s.adsOpportunityReservations).set({state:'RELEASED',releasedAt:new Date(),releaseReason:reason.slice(0,64),updatedAt:new Date()}).where(eq(s.adsOpportunityReservations.id,id)).returning();return this.receipt(released);
  });}
  async claim(id:string,eventId:string){return this.db.transaction(async(tx:any)=>{
    const [initial]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).limit(1);if(!initial)throw new NotFoundException('Opportunity not found');
    await this.lock(tx,initial.campaignId);
    const [row]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).for('update').limit(1);
    if(row.state==='CLAIMED'){if(row.claimEventId!==eventId)throw new ConflictException('Another pricing event already claimed this opportunity');return this.receipt(row);}
    const [event]=await tx.select().from(s.adsInteractions).where(eq(s.adsInteractions.id,eventId)).limit(1);
    const [assessment]=await tx.select().from(s.adsEventAssessments).where(eq(s.adsEventAssessments.eventId,eventId)).orderBy(sql`${s.adsEventAssessments.createdAt} DESC`,sql`${s.adsEventAssessments.id} DESC`).limit(1);
    if(row.isSimulated||row.state!=='ISSUED'||!event||event.serveId!==row.serveId||event.promoterId!==row.promoterId||event.createdAt>row.eventDeadline||event.createdAt<row.createdAt||event.verificationVersion!==2||!event.isValid||event.financialEligibility==='invalid'||event.assessmentStatus==='invalidated'||
      (row.pricingModel==='cpc'?event.type!=='click':event.type!=='viewable_impression'))throw new ConflictException('This event has no funded claim');
    const [journal]=await tx.select().from(s.adsEvidenceRecords).where(eq(s.adsEvidenceRecords.eventId,event.id)).limit(1);
    if(!journal||!adEventJournalMatches(event,journal)||(journal.payload as any).financialEligibility!=='pending'||!validEvidenceSignature({eventId:journal.eventId,partition:journal.partition,previousHash:journal.previousHash,payload:journal.payload,keyId:journal.keyId},journal.recordHash))throw new ConflictException('Evidence integrity could not be established');
    if(assessment&&assessment.outcome==='invalid')throw new ConflictException('This pricing event was rejected');
    const [claimed]=await tx.update(s.adsOpportunityReservations).set({state:'CLAIMED',claimEventId:eventId,claimedAt:new Date(),updatedAt:new Date()}).where(eq(s.adsOpportunityReservations.id,id)).returning();return this.receipt(claimed);
  });}
  /** Final invalid assessment closes unsettled exposure; quarantine continues to retain funds. */
  async reject(id:string,eventId:string){return this.db.transaction(async(tx:any)=>{
    const [initial]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).limit(1);if(!initial)throw new NotFoundException('Opportunity not found');
    await this.lock(tx,initial.campaignId);
    const [row]=await tx.select().from(s.adsOpportunityReservations).where(eq(s.adsOpportunityReservations.id,id)).for('update').limit(1);
    if(row.settledAt)throw new ConflictException('Settled claims require the financial reversal workflow');
    if(row.isSimulated||row.claimEventId&&row.claimEventId!==eventId)throw new ConflictException('Claim binding changed');
    const [event]=await tx.select().from(s.adsInteractions).where(eq(s.adsInteractions.id,eventId)).limit(1);
    const [assessment]=await tx.select().from(s.adsEventAssessments).where(eq(s.adsEventAssessments.eventId,eventId)).orderBy(sql`${s.adsEventAssessments.createdAt} DESC`,sql`${s.adsEventAssessments.id} DESC`).limit(1);
    if(!event||event.serveId!==row.serveId||event.createdAt>row.eventDeadline||(row.pricingModel==='cpc'?event.type!=='click':event.type!=='viewable_impression')||assessment?.outcome!=='invalid')throw new ConflictException('A final invalid assessment is required');
    const {recordHash,createdAt,...signed}=assessment;if(!validEvidenceSignature(signed,recordHash))throw new ConflictException('Assessment integrity could not be established');
    if(row.state==='RELEASED')return this.receipt(row);
    const [released]=await tx.update(s.adsOpportunityReservations).set({state:'RELEASED',releaseReason:'FINAL_INVALID_ASSESSMENT',releasedAt:new Date(),updatedAt:new Date()}).where(eq(s.adsOpportunityReservations.id,id)).returning();return this.receipt(released);
  });}
  async reconcile(){const due=await this.db.execute(sql`SELECT DISTINCT campaign_id FROM ads_opportunity_reservations WHERE is_simulated=false AND state IN('HELD','ISSUED') AND expires_at<=now() LIMIT 100`);
    for(const row of due.rows??due)await this.db.transaction(async(tx:any)=>{await this.lock(tx,row.campaign_id);await this.expire(tx,row.campaign_id);});return {campaigns:(due.rows??due).length};}
}
