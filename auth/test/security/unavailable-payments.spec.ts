
import { WithdrawalsService } from '../../../api/billing-api/src/modules/withdrawals/withdrawals.service';
import { SubscriptionsService } from '../../../api/billing-api/src/modules/subscriptions/subscriptions.service';
import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';
test('unsupported money writes stop at service boundary without provider/DB/wallet effects',async()=>{
 const forbidden=new Proxy({},{get(){throw Error('Unexpected effect');}});
 await expect(new WithdrawalsService(forbidden as any,forbidden as any,forbidden as any,forbidden as any).requestWithdrawal({userId:'owner',bankAccountId:'bank',amountUsd:5})).rejects.toThrow('unavailable pending');
 await expect(new SubscriptionsService(forbidden as any,forbidden as any,forbidden as any).subscribe({userId:'owner',userEmail:'owner@example.test',appSlug:'chat',planId:'plan',interval:'monthly'})).rejects.toThrow('unavailable pending');
});
test.each(['transfer.success','transfer.failed','transfer.reversed'])('signed %s cannot mutate or acknowledge legacy funds',async event=>{
 const forbidden=new Proxy({},{get(){throw Error('Unexpected effect');}});const hooks=new WebhooksService(forbidden as any,{verifyWebhookSignature:()=>true}as any,forbidden as any);
 await expect(hooks.handlePaystackWebhook(JSON.stringify({event,data:{reference:'old',transfer_code:'old'}}),'signed')).rejects.toThrow('operator reconciliation');
});
