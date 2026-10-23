/// <reference types="jest" />
import { describe, it, test, expect } from '@jest/globals';
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

describe('SubscriptionsService.cancelSubscription', () => {
  it('updates cancelAtPeriodEnd without prematurely cancelling active access', async () => {
    const updatedSub = { id: 'sub_1', userId: 'u1', status: 'active', cancelAtPeriodEnd: true };
    const mockDb: any = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [updatedSub],
          }),
        }),
      }),
    };
    const svc = new SubscriptionsService(mockDb, {} as any, {} as any);
    const res = await svc.cancelSubscription('u1', 'sub_1');
    expect(res).toEqual({ status: 'active', cancelAtPeriodEnd: true, subscription: updatedSub });
  });

  it('returns real status and does not error if subscription has already ended', async () => {
    const endedSub = { id: 'sub_ended', userId: 'u1', status: 'cancelled', cancelAtPeriodEnd: true };
    const mockDb: any = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [endedSub],
          }),
        }),
      }),
    };
    const svc = new SubscriptionsService(mockDb, {} as any, {} as any);
    const res = await svc.cancelSubscription('u1', 'sub_ended');
    expect(res).toEqual({ status: 'cancelled', cancelAtPeriodEnd: true, subscription: endedSub });
  });

  it('throws NotFoundException if subscription not found or not owned by user', async () => {
    const mockDb: any = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };
    const svc = new SubscriptionsService(mockDb, {} as any, {} as any);
    await expect(svc.cancelSubscription('u1', 'sub_unknown')).rejects.toThrow('Subscription not found');
  });
});

describe('WithdrawalLedgerService.registerRefundEvidence', () => {
  it('rejects identical preparedBy and reviewedBy operators (dual distinct required)', async () => {
    const { WithdrawalLedgerService } = require('../../../api/billing-api/src/modules/withdrawals/withdrawal-ledger.service');
    const svc = new WithdrawalLedgerService({} as any, { paymentDomain: () => 'test' } as any, {} as any);
    await expect(svc.registerRefundEvidence({
      reference: 'wd_12345678901234567890',
      transferCode: 'TRF_123',
      outcome: 'failed',
      providerEvidenceId: 'ev_123',
      preparedBy: 'operator1@example.com',
      reviewedBy: 'operator1@example.com',
      retainedFeeKobo: 5000,
      retainedStampDutyKobo: 5000,
    })).rejects.toThrow('Dual distinct operators');
  });

  it('rejects negative or invalid retained charges', async () => {
    const { WithdrawalLedgerService } = require('../../../api/billing-api/src/modules/withdrawals/withdrawal-ledger.service');
    const svc = new WithdrawalLedgerService({} as any, { paymentDomain: () => 'test' } as any, {} as any);
    await expect(svc.registerRefundEvidence({
      reference: 'wd_12345678901234567890',
      transferCode: 'TRF_123',
      outcome: 'failed',
      providerEvidenceId: 'ev_123',
      preparedBy: 'operator1@example.com',
      reviewedBy: 'operator2@example.com',
      retainedFeeKobo: -100,
      retainedStampDutyKobo: 5000,
    })).rejects.toThrow('Retained charges must be non-negative safe integers');
  });

  it('rejects invalid transfer reference format', async () => {
    const { WithdrawalLedgerService } = require('../../../api/billing-api/src/modules/withdrawals/withdrawal-ledger.service');
    const svc = new WithdrawalLedgerService({} as any, { paymentDomain: () => 'test' } as any, {} as any);
    await expect(svc.registerRefundEvidence({
      reference: 'bad_ref',
      transferCode: 'TRF_123',
      outcome: 'failed',
      providerEvidenceId: 'ev_123',
      preparedBy: 'operator1@example.com',
      reviewedBy: 'operator2@example.com',
      retainedFeeKobo: 5000,
      retainedStampDutyKobo: 5000,
    })).rejects.toThrow('Invalid transfer reference');
  });
});
