import {Inject,Injectable,Logger,OnModuleInit,OnModuleDestroy,NotFoundException,ConflictException} from '@nestjs/common';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '@crimfig/database/schema';
@Injectable()
export class CampaignRetentionWorker implements OnModuleInit,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;private busy=false;private readonly logger=new Logger('CampaignRetention');
  constructor(@Inject('DATABASE_CONNECTION')private readonly db:any){}
  onModuleInit(){if(process.env.ADS_SNAPSHOT_RETENTION_ENABLED==='true'){this.timer=setInterval(()=>{void this.sweep();},3600000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  async hold(campaignId:string,actorId:string,input:{active:boolean;requestId:string;reason:string}){
    return this.db.transaction(async(tx:any)=>{
      await tx.execute(sql`set local lock_timeout='5s'`);await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('ads-snapshot-retention',0))`);
      const [campaign]=await tx.select().from(s.adsCampaigns).where(eq(s.adsCampaigns.id,campaignId)).limit(1);if(!campaign)throw new NotFoundException('Campaign not found');
      const [receipt]=await tx.select().from(s.adsSupplyStateHistory).where(and(eq(s.adsSupplyStateHistory.requestId,input.requestId),eq(s.adsSupplyStateHistory.dimension,'retention_hold'))).limit(1);
      if(receipt){if(receipt.entityId!==campaignId||receipt.actorId!==actorId||receipt.toState!==(input.active?'held':'released')||receipt.reason!==input.reason)throw new ConflictException('Hold request identity changed');return {campaignId,active:input.active,replayed:true};}
      const [prior]=await tx.select().from(s.adsRetentionHolds).where(eq(s.adsRetentionHolds.campaignId,campaignId)).limit(1);
      await tx.insert(s.adsRetentionHolds).values({campaignId,actorId,...input}).onConflictDoUpdate({target:s.adsRetentionHolds.campaignId,set:{actorId,...input,updatedAt:new Date()}});
      await tx.insert(s.adsSupplyStateHistory).values({entityType:'campaign',entityId:campaignId,dimension:'retention_hold',fromState:prior?.active?'held':'released',toState:input.active?'held':'released',actorId,actorRole:'super_admin',requestId:input.requestId,reason:input.reason});
      return {campaignId,active:input.active,replayed:false};
    });
  }
  async sweep(){if(this.busy||process.env.ADS_SNAPSHOT_RETENTION_ENABLED!=='true')return;this.busy=true;
    try{const days=Number(process.env.ADS_SNAPSHOT_RETENTION_DAYS??365);if(!Number.isSafeInteger(days)||days<90||days>3650)throw new Error('Retention must be between 90 and 3650 days');
      await this.db.transaction(async(tx:any)=>{
        await tx.execute(sql`set local lock_timeout='5s'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('ads-snapshot-retention',0))`);await tx.execute(sql`set local statement_timeout='8s'`);
        await tx.execute(sql`UPDATE ads_campaign_changes SET before_snapshot=jsonb_build_object('retainedHash',before_hash,'purged',true),after_snapshot=jsonb_build_object('retainedHash',after_hash,'purged',true),purged_at=now()
          WHERE id IN (SELECT c.id FROM ads_campaign_changes c WHERE c.purged_at IS NULL AND c.created_at<now()-${days}*interval '1 day'
          AND NOT EXISTS(SELECT 1 FROM ads_retention_holds h WHERE h.campaign_id=c.campaign_id AND h.active) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
        await tx.execute(sql`UPDATE ads_campaign_submissions SET snapshot=jsonb_build_object('retainedHash',snapshot_hash,'purged',true),purged_at=now()
          WHERE id IN(SELECT s.id FROM ads_campaign_submissions s WHERE s.state IN('superseded','funding_rejected') AND s.snapshot_hash IS NOT NULL AND s.purged_at IS NULL
          AND s.created_at<now()-${days}*interval '1 day' AND NOT EXISTS(SELECT 1 FROM ads_retention_holds h WHERE h.campaign_id=s.campaign_id AND h.active)
          ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
        await tx.execute(sql`UPDATE ads_campaign_mutations SET result=jsonb_build_object('archived',true),purged_at=now()
          WHERE id IN(SELECT m.id FROM ads_campaign_mutations m WHERE m.purged_at IS NULL AND m.created_at<now()-${days}*interval '1 day'
          AND NOT EXISTS(SELECT 1 FROM ads_retention_holds h WHERE h.campaign_id=m.campaign_id AND h.active) ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)`);
      });
    }catch{this.logger.warn('Campaign retention did not complete; retained data has not been reported as purged.');}finally{this.busy=false;}
  }
}
