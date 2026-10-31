import type {ErrorMonitorSink} from './error-monitor.interceptor';
import type {SanitizedErrorMonitorEvent} from './error-monitor.contract';

/** Server-configured transport only; no cookies, redirects, raw exception or response-body logging. */
export class HttpErrorMonitorSink implements ErrorMonitorSink {
  constructor(private readonly env:Record<string,string|undefined>=process.env,private readonly send:typeof fetch=fetch) {}
  async recordEvent(event:SanitizedErrorMonitorEvent,sourceEventId?:string) {
    const address=this.env.ERROR_MONITOR_INGEST_URL?.trim();
    const key=this.env.ERROR_MONITOR_INTERNAL_KEY||this.env.INTERNAL_ECOSYSTEM_KEY;
    if(!address||!key) throw new Error('Error monitor transport is not configured');
    let url:URL;
    try {url=new URL(address);}catch{throw new Error('Invalid error monitor transport configuration');}
    const internal=url.hostname.endsWith('.railway.internal')||['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&internal))||url.username||url.password||url.search||url.hash||url.pathname!=='/api/v1/internal/error-monitor/events')
      throw new Error('Invalid error monitor transport configuration');
    // Explicit wire fields: normalizedRoute must map to the ingestion DTO's route field.
    const response=await this.send(url.toString(),{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(3000),
      headers:{'content-type':'application/json','x-internal-key':key},body:JSON.stringify({...(sourceEventId?{sourceEventId}:{}),occurredAt:event.occurredAt.toISOString(),service:event.service,environment:event.environment,source:event.source,httpMethod:event.httpMethod,
        route:event.normalizedRoute,statusCode:event.statusCode,errorCategory:event.errorCategory,safeSummary:event.safeSummary,isFinancialRoute:event.isFinancialRoute,
        ...(event.financialCategory?{financialCategory:event.financialCategory}:{}),requestId:event.requestId,correlationId:event.correlationId,
        ...(event.deploymentId?{deploymentId:event.deploymentId}:{}),...(event.upstreamService?{upstreamService:event.upstreamService}:{}),
        ...(event.upstreamStatusCode==null?{}:{upstreamStatusCode:event.upstreamStatusCode}),...(event.actorUserId?{actorUserId:event.actorUserId}:{}),context:event.sanitizedContext})})
      .catch(()=>{throw new Error('Error monitor transport failed');});
    if(!response.ok) throw new Error('Error monitor ingestion rejected the event');
    const result:unknown=await response.json().catch(()=>null);
    if(!result||typeof result!=='object'||!('status' in result)||result.status!=='accepted'||!('data' in result)||
      !result.data||typeof result.data!=='object'||!('recorded' in result.data)||result.data.recorded!==true) throw new Error('Error monitor ingestion was not confirmed');
    return result;
  }
}
