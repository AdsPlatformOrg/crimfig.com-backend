jest.mock('@crimfig/shared', () => ({
  ...jest.requireActual('../../../shared/src/financial-security/policy.config'),
  ...jest.requireActual('../../../shared/src/financial-security/private-transport'),
}));
import { WithdrawalAuthorityClient } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-authority.client';
import { WithdrawalDispatchService } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-dispatch.service';
import { WithdrawalsService } from '../../../api/billing-api/src/modules/withdrawals/withdrawals.service';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';

describe('PLAN-0052 withdrawal route security gate', () => {
  const input = { userId: 'owner', requestId: 'request', quoteId: 'quote', bankAccountId: 'bank', amountUsd: 5 };
  test('disabled release cannot reserve funds or dispatch', async () => {
    const ledger = { reserve: jest.fn() }, dispatch = { dispatch: jest.fn() };
    const service = new WithdrawalsService({} as any, {} as any, {} as any, {} as any, ledger as any, dispatch as any, new WithdrawalAuthorityClient());
    await expect(service.requestWithdrawal(input)).rejects.toThrow('held'); expect(ledger.reserve).not.toHaveBeenCalled(); expect(dispatch.dispatch).not.toHaveBeenCalled();
  });
  test('missing authority cannot fall back to the legacy ledger/provider', async () => {
    const ledger = { reserve: jest.fn() }, dispatch = { dispatch: jest.fn() };
    await expect(new WithdrawalsService({} as any, {} as any, {} as any, {} as any, ledger as any, dispatch as any).requestWithdrawal(input)).rejects.toThrow('Independent');
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
  test('legacy dispatch cannot claim or send a transfer', async () => {
    const ledger = { dispatchIntent: jest.fn() }, provider = { initiateTransfer: jest.fn() };
    await expect(new WithdrawalDispatchService(ledger as any, provider as any, new WithdrawalAuthorityClient()).dispatch('owner', 'reference')).rejects.toThrow('held');
    expect(ledger.dispatchIntent).not.toHaveBeenCalled(); expect(provider.initiateTransfer).not.toHaveBeenCalled();
  });
  test('direct Billing Paystack write is disabled even with valid-looking parameters', async () => {
    const network = jest.spyOn(globalThis, 'fetch');
    try {
      await expect(new PaystackService().initiateTransfer({ amountKobo: 500000, recipientCode: 'RCP_123', reference: `wd_${'a'.repeat(40)}` })).rejects.toThrow('Direct Billing payouts are disabled');
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  test('authority failure after claim never retries or refunds', async () => {
    const intent = { claimed: true, status: 'processing', dispatchStarted: false, authorityDigest: 'a'.repeat(64), reference: 'reference', userId: 'owner' };
    const ledger = { dispatchIntent: jest.fn().mockResolvedValue(intent), complete: jest.fn(), cancel: jest.fn() };
    const authority = { assertReleased: jest.fn(), execute: jest.fn().mockRejectedValue(new Error('lost response')) };
    const provider = { initiateTransfer: jest.fn() };
    expect(await new WithdrawalDispatchService(ledger as any, provider as any, authority as any).dispatch('owner', 'reference')).toMatchObject({ confirmation: 'unconfirmed' });
    expect(authority.execute).toHaveBeenCalledTimes(1); expect(ledger.complete).not.toHaveBeenCalled(); expect(ledger.cancel).not.toHaveBeenCalled(); expect(provider.initiateTransfer).not.toHaveBeenCalled();
  });
  test('existing undispatched request can still be read without new authorization or provider writes', async () => {
    const ledger = { dispatchIntent: jest.fn().mockResolvedValue({ dispatchStarted: false, status: 'pending' }) };
    const provider = { initiateTransfer: jest.fn(), verifyTransfer: jest.fn() };
    expect(await new WithdrawalDispatchService(ledger as any, provider as any).recover('owner', 'reference')).toMatchObject({ confirmation: 'not_dispatched' });
    expect(provider.verifyTransfer).not.toHaveBeenCalled(); expect(provider.initiateTransfer).not.toHaveBeenCalled();
  });
});
