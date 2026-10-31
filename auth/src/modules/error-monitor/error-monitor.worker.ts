import {Injectable,Logger,OnModuleInit,OnModuleDestroy} from '@nestjs/common';
import {resolveErrorMonitorConfig} from '@crimfig/shared';
import {ErrorMonitorService} from './error-monitor.service';
@Injectable()
export class ErrorMonitorWorker implements OnModuleInit,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;
  private busy=false;
  private readonly logger=new Logger('ErrorMonitorWorker');
  constructor(private readonly monitor:ErrorMonitorService) {}
  onModuleInit(){
    const config=resolveErrorMonitorConfig();
    if(process.env.ERROR_MONITOR_OUTBOX_WORKER_ENABLED!=='true'||!config.captureEnabled||!config.emailEnabled)return;
    this.timer=setInterval(()=>{void this.tick();},30000);this.timer.unref();
  }
  async tick(){if(this.busy)return;this.busy=true;try{await this.monitor.processDueOutbox();}catch{this.logger.warn('Error monitor outbox dispatch failed; pending leases will be reconciled.');}finally{this.busy=false;}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
