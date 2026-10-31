import {Injectable,CanActivate,ExecutionContext} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {FINANCIAL_OPERATION_KEY,ensureRequestId,redactAndSanitizeErrorEvent} from './error-monitor.contract';
import {resolveErrorMonitorConfig} from './error-alert.config';
import type {ErrorMonitorSink} from './error-monitor.interceptor';

@Injectable()
export class ErrorMonitorMetadataGuard implements CanActivate {
  constructor(private readonly reflector:Reflector){}
  canActivate(context:ExecutionContext){if(context.getType()==='http')context.switchToHttp().getRequest().__monitorFinancial=this.reflector.getAllAndOverride(FINANCIAL_OPERATION_KEY,[context.getHandler(),context.getClass()]);return true;}
}
/** Finish listener also observes guard failures, explicit error responses and upstream proxy status. */
export function errorMonitorBoundary(service:string,sink:ErrorMonitorSink){
  return (req:any,res:any,next:()=>void)=>{
    req.requestId=ensureRequestId(req.headers?.['x-request-id']);req.correlationId=ensureRequestId(req.headers?.['x-correlation-id']??req.requestId);
    res.setHeader('X-Request-Id',req.requestId);res.setHeader('X-Correlation-Id',req.correlationId);
    res.once('finish',()=>{
      if(req.__crimfigErrorCaptured||res.statusCode<400||res.statusCode>599)return;
      const route=req.route?.path||req.originalUrl||req.url;
      if(/\/(admin|internal)\/error-monitor\b/i.test(route))return;
      try{
        if(!resolveErrorMonitorConfig().captureEnabled)return;
        req.__crimfigErrorCaptured=true;
        const event=redactAndSanitizeErrorEvent({service,source:'server',httpMethod:req.method,route,statusCode:res.statusCode,
          requestId:req.requestId,correlationId:req.correlationId,isFinancialRoute:!!req.__monitorFinancial?.isFinancial,financialCategory:req.__monitorFinancial?.category,
          errorCategory:'HTTP_BOUNDARY_FAILURE',actorUserId:req.user?.sub});
        void sink.recordEvent(event).catch(()=>{console.warn('ERROR_MONITOR_BOUNDARY_PERSISTENCE_FAILED');});
      }catch{console.warn('ERROR_MONITOR_BOUNDARY_CONFIGURATION_FAILED');}
    });next();
  };
}
