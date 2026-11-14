import {Injectable,ServiceUnavailableException,ConflictException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AD_AUTHORITY_VERSION} from '@crimfig/shared';
import type {OpportunityInput} from '../../../../billing-api/src/modules/ecosystem/ad-opportunity.service';
import {
  opportunityConflictCodes,
  type OpportunityCapacityDetails,
  type OpportunityConflictCode,
} from '../../../../billing-api/src/modules/ecosystem/ad-opportunity-conflict-codes';
export interface OpportunityReceipt {authorityVersion:string;reservationId:string;opportunityId:string;campaignId:string;escrowId:string;escrowAllocatedUsdCents:number;submissionId:string;contentRevision:number;creativeId:string;serveId:string|null;promoterId:string;websiteId:string;slotId:string;policyVersion:string;state:string;priceNanos:string;eventDeadline:string;ingestDeadline:string;expiresAt:string;bindingFingerprint:string;}
export class OpportunityHttpError extends ServiceUnavailableException {
  constructor(readonly upstreamStatus: number) {
    super('Opportunity outcome is unconfirmed; reconcile by its existing identity');
  }
}
export class OpportunityConflictError extends ConflictException {
  constructor(
    readonly reasonCode?: OpportunityConflictCode,
    readonly capacityDetails?: OpportunityCapacityDetails,
  ) {
    super('Opportunity eligibility or capacity changed');
  }
}
const CAPACITY_LIMIT_TYPES = new Set(['reservable_escrow', 'daily_budget', 'hourly_pacing', 'frequency_cap']);
const CAPACITY_UNITS = new Set(['usd_nanos', 'impressions_per_day']);
function parseCapacityDetails(value: unknown): OpportunityCapacityDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.limitType !== 'string' || !CAPACITY_LIMIT_TYPES.has(raw.limitType)) return undefined;
  if (typeof raw.unit !== 'string' || !CAPACITY_UNITS.has(raw.unit)) return undefined;
  if (raw.decision !== 'rejected_house_fallback') return undefined;
  return {
    limitType: raw.limitType as OpportunityCapacityDetails['limitType'],
    unit: raw.unit as OpportunityCapacityDetails['unit'],
    allowanceNanos: typeof raw.allowanceNanos === 'string' && /^\d{1,24}$/.test(raw.allowanceNanos) ? raw.allowanceNanos : undefined,
    usedOrReservedNanos: typeof raw.usedOrReservedNanos === 'string' && /^\d{1,24}$/.test(raw.usedOrReservedNanos) ? raw.usedOrReservedNanos : undefined,
    requestedNanos: typeof raw.requestedNanos === 'string' && /^\d{1,24}$/.test(raw.requestedNanos) ? raw.requestedNanos : undefined,
    availableNanos: typeof raw.availableNanos === 'string' && /^\d{1,24}$/.test(raw.availableNanos) ? raw.availableNanos : undefined,
    outstandingReservedNanos: typeof raw.outstandingReservedNanos === 'string' && /^\d{1,24}$/.test(raw.outstandingReservedNanos) ? raw.outstandingReservedNanos : undefined,
    carryNanos: typeof raw.carryNanos === 'string' && /^\d{1,24}$/.test(raw.carryNanos) ? raw.carryNanos : undefined,
    remainingBudgetNanos: typeof raw.remainingBudgetNanos === 'string' && /^\d{1,24}$/.test(raw.remainingBudgetNanos) ? raw.remainingBudgetNanos : undefined,
    allowanceCount: typeof raw.allowanceCount === 'number' && Number.isFinite(raw.allowanceCount) ? raw.allowanceCount : undefined,
    usedCount: typeof raw.usedCount === 'number' && Number.isFinite(raw.usedCount) ? raw.usedCount : undefined,
    requestedCount: typeof raw.requestedCount === 'number' && Number.isFinite(raw.requestedCount) ? raw.requestedCount : undefined,
    availableCount: typeof raw.availableCount === 'number' && Number.isFinite(raw.availableCount) ? raw.availableCount : undefined,
    decision: 'rejected_house_fallback',
  };
}
@Injectable()
export class OpportunityClient {
  private readonly base:string;private readonly key:string;
  constructor(config:ConfigService){const url=new URL(config.get<string>('BILLING_API_URL')||'http://127.0.0.1:3008/api/v1');if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['','/','/api/v1'].includes(url.pathname.replace(/\/$/,'')))throw new Error('Invalid Billing authority URL');this.base=`${url.origin}/api/v1/ecosystem/ad-opportunities`;this.key=config.get<string>('INTERNAL_ECOSYSTEM_KEY')||'';}
  private async call(path:string,body?:unknown):Promise<any>{if(!this.key)throw new ServiceUnavailableException('Billing authority is not configured');try{
    const response=await fetch(this.base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-internal-key':this.key},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.status===409){
      const payload: unknown = await response.json().catch(() => null);
      const code = payload && typeof payload === 'object' && 'code' in payload ? payload.code : undefined;
      const reason = opportunityConflictCodes.find(value => value === code);
      const capacityDetails = payload && typeof payload === 'object' && 'capacityDetails' in payload
        ? parseCapacityDetails((payload as { capacityDetails?: unknown }).capacityDetails)
        : undefined;
      throw new OpportunityConflictError(reason, capacityDetails);
    }
    if(!response.ok)throw new OpportunityHttpError(response.status);
    const json:any=await response.json();if(json.status!=='success'||!json.data)throw new Error('Invalid acknowledgement');return json.data;
  }catch(error){if(error instanceof ConflictException||error instanceof OpportunityHttpError)throw error;throw new ServiceUnavailableException('Opportunity outcome is unconfirmed; reconcile by its existing identity');}}
  private checked(value:any,input:Partial<OpportunityInput> & Partial<OpportunityReceipt>):OpportunityReceipt {
    if(value?.authorityVersion!==AD_AUTHORITY_VERSION||typeof value.reservationId!=='string'||!/^[a-f0-9]{64}$/.test(value.bindingFingerprint)||!/^\d+$/.test(value.priceNanos)||
      ['opportunityId','campaignId','creativeId','submissionId','contentRevision','priceNanos','promoterId','websiteId','slotId','policyVersion','reservationId','escrowId','escrowAllocatedUsdCents','bindingFingerprint'].some(k=>(input as any)[k]!==undefined&&value[k]!== (input as any)[k]))throw new ServiceUnavailableException('Opportunity receipt does not match its binding');return value;
  }
  async reserve(input:OpportunityInput){return this.checked(await this.call('/reserve',input),input);}
  async issue(receipt:OpportunityReceipt){const result=await this.call(`/${encodeURIComponent(receipt.reservationId)}/issue`,{bindingFingerprint:receipt.bindingFingerprint});const current=this.checked(result.receipt,receipt);
    if(!['ISSUED','CLAIMED'].includes(current.state)||!current.serveId||result.serveId!==current.serveId||!result.render)throw new ServiceUnavailableException('Issue receipt is incomplete');return {...result,receipt:current};}
  async read(id:string){return this.checked(await this.call(`/${encodeURIComponent(id)}`),{});}
  async reject(id:string,eventId:string){return this.checked(await this.call(`/${encodeURIComponent(id)}/reject`,{eventId}),{});}
  async claim(id:string,eventId:string){return this.checked(await this.call(`/${encodeURIComponent(id)}/claim`,{eventId}),{});}
}
