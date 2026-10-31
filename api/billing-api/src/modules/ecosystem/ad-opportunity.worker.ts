import {Inject,Injectable,Logger,OnModuleInit,OnModuleDestroy} from '@nestjs/common';
import {sql} from 'drizzle-orm';
import {createHash} from 'crypto';
import {AdOpportunityService} from './ad-opportunity.service';
import {AdSettlementService} from './ad-settlement.service';
import {CampaignEscrowService} from './campaign-escrow.service';
@Injectable()
export class AdOpportunityWorker implements OnModuleInit,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;private busy=false;private readonly logger=new Logger('AdOpportunityReconciler');
  constructor(@Inject('DATABASE_CONNECTION')private readonly db:any,private readonly authority:AdOpportunityService,private readonly settlement:AdSettlementService,private readonly escrows:CampaignEscrowService){}
  onModuleInit(){if(process.env.ADS_OPPORTUNITY_WORKER_ENABLED==='true'){this.timer=setInterval(()=>{void this.tick();},30000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  async tick(){if(this.busy)return;this.busy=true;try{
    await this.authority.reconcile();
    const events=await this.db.execute(sql`SELECT r.id,e.id AS event_id FROM ads_opportunity_reservations r JOIN ads_interactions e ON e.serve_id=r.serve_id
      WHERE r.state='ISSUED' AND NOT r.is_simulated AND e.created_at<=r.event_deadline AND e.verification_version=2 AND e.financial_eligibility='pending'
      AND e.type=CASE WHEN r.pricing_model='cpc' THEN 'click' ELSE 'viewable_impression' END ORDER BY e.created_at,e.id LIMIT 100`);
    for(const e of events.rows)try{await this.authority.claim(e.id,e.event_id);}catch{/* Retained for assessment; never reports financial success. */}
    const rejected=await this.db.execute(sql`SELECT r.id,a.event_id FROM ads_opportunity_reservations r JOIN ads_interactions e ON e.serve_id=r.serve_id AND (r.claim_event_id IS NULL OR r.claim_event_id=e.id) JOIN LATERAL
      (SELECT * FROM ads_event_assessments a WHERE a.event_id=e.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1)a ON true
      WHERE r.state IN('ISSUED','CLAIMED') AND NOT r.is_simulated AND r.settled_at IS NULL AND a.outcome='invalid' AND e.type=CASE WHEN r.pricing_model='cpc' THEN 'click' ELSE 'viewable_impression' END LIMIT 100`);
    for(const r of rejected.rows)try{await this.authority.reject(r.id,r.event_id);}catch{/* Preserve funded exposure on ambiguous rejection. */}
    const claims=await this.db.execute(sql`SELECT DISTINCT campaign_id FROM ads_opportunity_reservations r WHERE state='CLAIMED' AND settled_at IS NULL AND NOT is_simulated AND (SELECT a.outcome FROM ads_event_assessments a WHERE a.event_id=r.claim_event_id ORDER BY a.created_at DESC,a.id DESC LIMIT 1)='eligible' LIMIT 100`);
    const periodEnd=new Date(Math.floor(Date.now()/60000)*60000);
    for(const c of claims.rows){try{
      const hex=createHash('sha256').update(`${c.campaign_id}:${periodEnd.toISOString()}`).digest('hex');const requestId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      await this.settlement.settle(c.campaign_id,requestId,periodEnd);
    }catch{this.logger.warn('A funded claim remains pending reconciliation.');}}
    const stopped=await this.db.execute(sql`SELECT c.id,c.advertiser_id FROM ads_campaigns c JOIN ads_campaign_escrows e ON e.campaign_id=c.id WHERE c.status IN('paused','trash') AND c.submission_intent_id IS NULL AND e.status='active' AND e.release_pending=true
      AND NOT EXISTS(SELECT 1 FROM ads_opportunity_reservations r WHERE r.escrow_id=e.id AND r.escrow_allocated_usd_cents=e.allocated_usd_cents AND NOT r.is_simulated AND r.settled_at IS NULL AND r.state IN('HELD','ISSUED','CLAIMED'))
      AND EXISTS(SELECT 1 FROM ads_opportunity_reservations r WHERE r.escrow_id=e.id AND NOT r.is_simulated) LIMIT 100`);
    for(const c of stopped.rows)try{await this.escrows.change(c.advertiser_id,c.id,'release');}catch{this.logger.warn('Stopped campaign funding remains retained for reconciliation.');}
  }catch{this.logger.warn('Opportunity reconciliation did not complete.');}finally{this.busy=false;}}
}
