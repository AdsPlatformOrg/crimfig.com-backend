import {captureDiagnostics,reserveDiagnosticCapture,diagnosticScope,observeDiagnosticResponse} from './request-diagnostics';
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
    req.__monitorBoundary=true;observeDiagnosticResponse(req,res);
    req.requestId=ensureRequestId(req.headers?.['x-request-id']);req.correlationId=ensureRequestId(req.headers?.['x-correlation-id']??req.requestId);
    res.setHeader('X-Request-Id',req.requestId);res.setHeader('X-Correlation-Id',req.correlationId);
    const finalize=(aborted=false)=>{
      const statusCode=aborted?499:res.statusCode;
      if(req.__crimfigErrorCaptured||statusCode<400||statusCode>599)return;
      const route=req.route?.path||req.originalUrl||req.url;
      if(/\/(admin|internal)\/error-monitor\b/i.test(route))return;
      try{
        if(!resolveErrorMonitorConfig().captureEnabled)return;
        req.__crimfigErrorCaptured=true;
        const diagnostics=reserveDiagnosticCapture(service)?captureDiagnostics(req,res):{version:1,status:'metadata_only',reason:'Detailed capture rate limit reached'} as any;
        if(aborted){diagnostics.completion='aborted';diagnostics.response={status:res.statusCode,body:{status:'partial',reason:'Connection closed before response finished'}};}
        if(req.__monitorException&&diagnostics.status!=='metadata_only')diagnostics.exception=req.__monitorException;
        const event=redactAndSanitizeErrorEvent({...req.__monitorPendingCapture,diagnostics,environment:resolveErrorMonitorConfig().environment,deploymentId:process.env.RAILWAY_DEPLOYMENT_ID,service,source:'server',httpMethod:req.method,route,statusCode,
          requestId:req.requestId,correlationId:req.correlationId,isFinancialRoute:!!req.__monitorFinancial?.isFinancial,financialCategory:req.__monitorFinancial?.category,
          errorCategory:req.__monitorPendingCapture?.errorCategory||'HTTP_BOUNDARY_FAILURE',actorUserId:req.user?.sub});
        void sink.recordEvent(event).catch(()=>{console.warn('ERROR_MONITOR_BOUNDARY_PERSISTENCE_FAILED');});
      }catch{console.warn('ERROR_MONITOR_BOUNDARY_CONFIGURATION_FAILED');}
    };
    res.once('finish',()=>finalize());
    res.once('close',()=>{if(!res.writableFinished&&!res.finished)finalize(true);});
    diagnosticScope(next,req);
  };
}
