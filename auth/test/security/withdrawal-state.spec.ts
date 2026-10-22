import { withdrawalTransition, withdrawalBalances, verifiedTransferOutcome } from '../../../api/billing-api/src/modules/withdrawals/withdrawal-state';

describe('Withdrawal reserved-principal transitions', () => {
  it.each(['pending', 'processing'] as const)('consumes a %s reserve once on success', state => {
    const next = withdrawalTransition(state, 'success', 500);
    expect(withdrawalBalances(100, 500, next)).toEqual({ available: 100, locked: 0 });
    expect(withdrawalTransition(next.status, 'success', 500).changed).toBe(false);
  });
  it.each(['failed', 'reversed'] as const)('refunds a reserved transfer once on %s', outcome => {
    const next = withdrawalTransition('processing', outcome, 500);
    const balances = withdrawalBalances(100, 500, next);
    expect(balances).toEqual({ available: 600, locked: 0 });
    const repeat = withdrawalTransition(next.status, outcome, 500);
    expect(withdrawalBalances(balances.available, balances.locked, repeat)).toEqual(balances);
  });
  it('refunds a post-success reversal without consuming a different reserve', () => {
    const next = withdrawalTransition('completed', 'reversed', 500);
    expect(withdrawalBalances(100, 700, next)).toEqual({ available: 600, locked: 700 });
    expect(withdrawalTransition('reversed', 'reversed', 500).changed).toBe(false);
  });
  it('does not refund twice when failure and reversal callbacks overlap', () => {
    expect(withdrawalTransition('failed', 'reversed', 500).availableDelta).toBe(0);
    expect(withdrawalTransition('reversed', 'failed', 500).availableDelta).toBe(0);
  });
  it.each(['failed', 'reversed', 'cancelled'] as const)('rejects a success contradicting %s', state => {
    expect(() => withdrawalTransition(state, 'success', 500)).toThrow();
  });
  it('rejects failure after success and inconsistent wallet balances', () => {
    expect(() => withdrawalTransition('completed', 'failed', 500)).toThrow();
    expect(() => withdrawalBalances(100, 499, withdrawalTransition('processing', 'failed', 500))).toThrow();
    expect(() => withdrawalBalances(2147483647, 500, withdrawalTransition('processing', 'failed', 500))).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 2147483648])('rejects invalid principal %s', value => {
    expect(() => withdrawalTransition('pending', 'success', value)).toThrow();
  });
});


describe('Provider transfer evidence binding', () => {
  const expected = { reference: 'withdrawal_1234567890', amountKobo: 500000, recipientCode: 'RCP_test123', domain: 'test' as const, transferCode: 'TRF_test123' };
  const proof = { reference: expected.reference, amount: expected.amountKobo, currency: 'NGN', recipient: { recipient_code: expected.recipientCode }, domain: 'test', transfer_code: expected.transferCode, status: 'success' };
  it.each(['success', 'failed', 'reversed'])('accepts exact authenticated %s evidence', status => {
    expect(verifiedTransferOutcome(expected, { ...proof, status })).toBe(status);
  });
  it.each([
    { reference: 'another_transfer_12345' }, { amount: 500001 }, { amount: '500000' }, { currency: 'USD' },
    { domain: 'live' }, { recipient: { recipient_code: 'RCP_other' } }, { recipient: null },
    { transfer_code: 'TRF_other' }, { transfer_code: '' }, { status: 'pending' }, { status: 'otp' },
  ])('rejects mismatched or incomplete provider proof %j', patch => {
    expect(() => verifiedTransferOutcome(expected, { ...proof, ...patch })).toThrow();
  });
  it('rejects URL flags and malformed stored principal/reference', () => {
    expect(() => verifiedTransferOutcome(expected, { status: 'success' })).toThrow();
    expect(() => verifiedTransferOutcome({ ...expected, amountKobo: -1 }, proof)).toThrow();
    expect(() => verifiedTransferOutcome({ ...expected, reference: 'short' }, proof)).toThrow();
    expect(() => withdrawalTransition('pending', 'otp' as any, 500)).toThrow();
  });
});
