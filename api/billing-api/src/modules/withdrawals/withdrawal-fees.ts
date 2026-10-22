/** Standard Nigerian non-payroll Paystack schedule reviewed 2026-10-22.
 * Sources: support.paystack.com/en/articles/2130370 and /7573314.
 * This quote policy does not establish actual charged/refunded fees; provider reconciliation remains mandatory.
 */
export const WITHDRAWAL_FEE_POLICY = 'paystack-ng-standard-2026-10-22';
const MAX_KOBO = 2147483647;
export function transferCharges(netKobo: number) {
  if (!Number.isSafeInteger(netKobo) || netKobo <= 0 || netKobo > MAX_KOBO) throw new Error('Invalid net payout');
  const transferFeeKobo = netKobo <= 500000 ? 1000 : netKobo <= 5000000 ? 2500 : 5000;
  const stampDutyKobo = netKobo >= 1000000 ? 5000 : 0;
  return { transferFeeKobo, stampDutyKobo, totalFeeKobo: transferFeeKobo + stampDutyKobo };
}

/** Deduct actual scheduled charges from a fixed gross budget; never keep an artificial tier difference.
 * At discontinuities there may be no exact solution. Request a different amount rather than overcharge.
 */
export function netWithdrawalQuote(grossKobo: number) {
  if (!Number.isSafeInteger(grossKobo) || grossKobo <= 0 || grossKobo > MAX_KOBO) throw new Error('Invalid gross withdrawal');
  const candidates = [1000, 2500, 7500, 10000].flatMap(fee => {
    const netKobo = grossKobo - fee;
    if (netKobo <= 0) return [];
    const charges = transferCharges(netKobo);
    return charges.totalFeeKobo === fee ? [{ policy: WITHDRAWAL_FEE_POLICY, grossKobo, netKobo, ...charges }] : [];
  });
  if (candidates.length !== 1) throw new Error('Choose another withdrawal amount: exact net payout is unavailable at this fee boundary');
  return candidates[0];
}
