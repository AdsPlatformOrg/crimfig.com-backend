/** Deterministic money deltas for a previously reserved, provider-bound withdrawal.
 * This is not provider verification or a DB commit. Call only inside the locked receipt transaction.
 */
export type WithdrawalState = 'pending' | 'processing' | 'completed' | 'failed' | 'reversed' | 'cancelled';
export type TransferOutcome = 'success' | 'failed' | 'reversed';
const MAX_CENTS = 2147483647;

export function withdrawalTransition(state: WithdrawalState, outcome: TransferOutcome, cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_CENTS) throw new Error('Invalid withdrawal cents');
  if (!['success', 'failed', 'reversed'].includes(outcome)) throw new Error('Unknown transfer outcome');
  const target: WithdrawalState = outcome === 'success' ? 'completed' : outcome;
  if (state === target) return { status: state, availableDelta: 0, lockedDelta: 0, changed: false };
  if (state === 'cancelled') throw new Error('Cancelled withdrawal requires reconciliation');
  if (state === 'failed' || state === 'reversed') {
    if (outcome === 'success') throw new Error('Conflicting terminal withdrawal outcome');
    // Failure/reversal both return the same principal; a later reversal cannot return it again.
    return { status: state === 'reversed' ? state : target, availableDelta: 0, lockedDelta: 0, changed: state !== 'reversed' };
  }
  if (state === 'completed') {
    if (outcome !== 'reversed') throw new Error('Conflicting terminal withdrawal outcome');
    // Provider reversal can follow success. The reserve was already consumed at success.
    return { status: target, availableDelta: cents, lockedDelta: 0, changed: true };
  }
  if (state !== 'pending' && state !== 'processing') throw new Error('Unknown withdrawal state');
  return { status: target, availableDelta: outcome === 'success' ? 0 : cents, lockedDelta: -cents, changed: true };
}

export function withdrawalBalances(available: number, locked: number, delta: { availableDelta: number; lockedDelta: number }) {
  const values = [available, locked, available + delta.availableDelta, locked + delta.lockedDelta];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS)) {
    throw new Error('Withdrawal wallet requires reconciliation');
  }
  return { available: values[2], locked: values[3] };
}


export interface ReservedTransfer {
  reference: string;
  amountKobo: number;
  recipientCode: string;
  domain: 'test' | 'live';
  transferCode?: string | null;
}

/** Use authenticated provider data only. Browser/URL status is never acceptable proof. */
export function verifiedTransferOutcome(expected: ReservedTransfer, data: unknown): TransferOutcome {
  const value = data as Record<string, unknown> | null;
  if (!expected || !/^[a-z0-9_-]{16,50}$/.test(expected.reference) ||
      !Number.isSafeInteger(expected.amountKobo) || expected.amountKobo <= 0 ||
      !/^RCP_[A-Za-z0-9]+$/.test(expected.recipientCode) || !['test', 'live'].includes(expected.domain)) {
    throw new Error('Invalid reserved transfer binding');
  }
  const recipient = value?.recipient as Record<string, unknown> | null;
  if (!value || value.reference !== expected.reference || value.amount !== expected.amountKobo ||
      value.currency !== 'NGN' || value.domain !== expected.domain ||
      recipient?.recipient_code !== expected.recipientCode ||
      typeof value.transfer_code !== 'string' || !/^TRF_[A-Za-z0-9]+$/.test(value.transfer_code) ||
      (expected.transferCode != null && value.transfer_code !== expected.transferCode) ||
      !['success', 'failed', 'reversed'].includes(value.status as string)) {
    throw new Error('Provider transfer does not match reserved withdrawal');
  }
  return value.status as TransferOutcome;
}
