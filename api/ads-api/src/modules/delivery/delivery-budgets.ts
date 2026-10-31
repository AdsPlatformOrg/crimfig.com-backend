/** Initial bounded runtime policy; tune from staging measurements during the deferred test review. */
export const DELIVERY_RUNTIME={version:'delivery-runtime-v1',candidateMs:2500,auctionMs:100,serverMs:9500,sdkMs:15000} as const;
export class DeliveryDeadlineError extends Error {constructor(readonly stage:string){super('Ad delivery deadline exceeded');this.name='DeliveryDeadlineError';}}
export function requireDeliveryTime(deadline:number,stage:string){if(Date.now()>=deadline)throw new DeliveryDeadlineError(stage);}
/** Selection work has no financial side effects. A late result is discarded, never committed as a winner. */
export async function withinDeliveryBudget<T>(work:PromiseLike<T>,deadline:number,stage:string):Promise<T>{
  requireDeliveryTime(deadline,stage);let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve(work),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DeliveryDeadlineError(stage)),Math.max(1,deadline-Date.now()));})]);}
  finally{if(timer)clearTimeout(timer);}
}
