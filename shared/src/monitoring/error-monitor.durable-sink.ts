import {Inject,Injectable,Logger,OnModuleInit,OnModuleDestroy} from '@nestjs/common';
import {randomUUID} from 'crypto';
import {sql} from 'drizzle-orm';
import {HttpErrorMonitorSink} from './error-monitor.http-sink';
import type {ErrorMonitorSink} from './error-monitor.interceptor';
import type {SanitizedErrorMonitorEvent} from './error-monitor.contract';
import {resolveErrorMonitorConfig} from './error-alert.config';

@Injectable()
export class DurableErrorMonitorSink implements ErrorMonitorSink,OnModuleInit,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;private busy=false;
  private readonly logger=new Logger('DurableErrorMonitorSink');
  constructor(@Inject('DATABASE_CONNECTION') private readonly db:any,private readonly serviceName:string){}
  async recordEvent(event:SanitizedErrorMonitorEvent){
    if(!resolveErrorMonitorConfig().captureEnabled)return {recorded:false,reason:'CAPTURE_DISABLED'};
    const id=randomUUID();
    if(event.service!==this.serviceName || event.environment!==resolveErrorMonitorConfig().environment)throw new Error('Monitor source scope mismatch');
    await this.db.execute(sql`INSERT INTO error_monitor_source_outbox(id,service,environment,payload) VALUES (${id},${event.service},${event.environment},${JSON.stringify(event)}::jsonb)`);
    return {queued:true,sourceEventId:id}; // Queued locally is distinct from confirmed central persistence.
  }
  onModuleInit(){if(process.env.ERROR_MONITOR_SOURCE_WORKER_ENABLED==='true'){this.timer=setInterval(()=>{void this.flush();},10000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  async flush(){
    if(this.busy||!resolveErrorMonitorConfig().captureEnabled)return;this.busy=true;
    try{
      await this.db.execute(sql`UPDATE error_monitor_source_outbox SET status='dead',lease_id=NULL,lease_expires_at=NULL,last_error_code='RETRY_LIMIT_REACHED'
        WHERE service=${this.serviceName} AND environment=${resolveErrorMonitorConfig().environment} AND status='processing' AND attempts>=20 AND lease_expires_at<=now()`);
      const leaseId=randomUUID();
      const result=await this.db.execute(sql`UPDATE error_monitor_source_outbox SET status='processing',lease_id=${leaseId},lease_expires_at=now()+interval '30 seconds',attempts=attempts+1
        WHERE id IN (SELECT id FROM error_monitor_source_outbox WHERE service=${this.serviceName} AND environment=${resolveErrorMonitorConfig().environment} AND status IN ('pending','failed','processing') AND attempts<20
          AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY next_attempt_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`);
      for(const row of result.rows??result){
        try{
          const event={...row.payload,occurredAt:new Date(row.payload.occurredAt)} as SanitizedErrorMonitorEvent;
          await new HttpErrorMonitorSink().recordEvent(event,row.id);
          await this.db.execute(sql`UPDATE error_monitor_source_outbox SET status='delivered',payload='{}'::jsonb,delivered_at=now(),lease_id=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=${row.id} AND lease_id=${leaseId}`);
        }catch{
          await this.db.execute(sql`UPDATE error_monitor_source_outbox SET status=CASE WHEN attempts>=20 THEN 'dead' ELSE 'failed' END,
            next_attempt_at=now()+least(3600,power(2,least(attempts,10))*5)*interval '1 second',last_error_code='CENTRAL_INGESTION_UNCONFIRMED',lease_id=NULL,lease_expires_at=NULL WHERE id=${row.id} AND lease_id=${leaseId}`);
        }
      }
    }catch{this.logger.warn('Source error outbox could not be processed; persisted work remains pending.');}finally{this.busy=false;}
  }
}
