/** Standard Nigerian non-payroll Paystack schedule reviewed 2026-10-22.
 * Sources: support.paystack.com/en/articles/2130370 and /7573314.
 * This quote policy does not establish actual charged/refunded fees; provider reconciliation remains mandatory.
 */
export const WITHDRAWAL_FEE_POLICY = 'paystack-ng-standard-2026-10-22';
export const WITHDRAWAL_REFUND_POLICY = 'deduct-confirmed-nonrefundable-charges-v1';
const MAX_KOBO = 2147483647;
export function transferCharges(netKobo: number) {
  if (!Number.isSafeInteger(netKobo) || netKobo <= 0 || netKobo > MAX_KOBO) throw new Error('Invalid net payout');
  const transferFeeKobo = netKobo <= 500000 ? 1000 : netKobo <= 5000000 ? 2500 : 5000;
  const stampDutyKobo = netKobo >= 1000000 ? 5000 : 0;
  return { transferFeeKobo, stampDutyKobo, totalFeeKobo: transferFeeKobo + stampDutyKobo };
}

/** Convert confirmed retained charges using the original six-decimal quote rate.
 * Round to the nearest USD cent (half up), keep the NGN evidence for reconciliation.
 * This function calculates only; its caller must authenticate and bind the evidence.
 */
export function withdrawalRefundCents(amountUsdCents: number, rate: number, retainedKobo: number, quotedFeesKobo: number) {
  if (!Number.isSafeInteger(amountUsdCents) || amountUsdCents <= 0 || amountUsdCents > MAX_KOBO ||
      !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(retainedKobo) || retainedKobo < 0 ||
      !Number.isSafeInteger(quotedFeesKobo) || quotedFeesKobo < 0 || quotedFeesKobo > MAX_KOBO || retainedKobo > quotedFeesKobo) {
    throw new Error('Invalid confirmed refund charges');
  }
  const scaled = BigInt(rate.toFixed(6).replace('.', ''));
  if (scaled <= 0n) throw new Error('Invalid refund exchange rate');
  const retainedUsdCents = Number((BigInt(retainedKobo) * 1000000n * 2n + scaled) / (2n * scaled));
  if (!Number.isSafeInteger(retainedUsdCents) || retainedUsdCents > amountUsdCents) throw new Error('Refund charges exceed original debit');
  return { retainedUsdCents, refundUsdCents: amountUsdCents - retainedUsdCents };
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
