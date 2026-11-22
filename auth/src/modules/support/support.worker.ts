import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { config } from '../../config/config';
import { SupportService } from './support.service';
@Injectable()
export class SupportWorker implements OnModuleInit,OnModuleDestroy {
 private timer?:ReturnType<typeof setInterval>;private busy=false;private logger=new Logger('SupportWorker');
 constructor(private readonly support:SupportService){}
 onModuleInit(){if(!config.SUPPORT.OUTBOX_WORKER_ENABLED)return;this.timer=setInterval(()=>void this.tick(),30000);this.timer.unref();}
 async tick(){if(this.busy)return;this.busy=true;try{await this.support.dispatch();}catch{this.logger.warn('Support dispatch unavailable; durable jobs retained');}finally{this.busy=false;}}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
}
