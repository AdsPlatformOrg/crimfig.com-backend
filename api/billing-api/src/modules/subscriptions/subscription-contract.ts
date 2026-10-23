import { APP_PLANS } from './subscription-catalog';

export const SUBSCRIPTION_CONTRACT_VERSION = 2;
export function subscriptionPrice(appSlug: string, planId: string, interval: string) {
  if (!['monthly', 'annual'].includes(interval)) throw new RangeError('Unsupported subscription interval');
  const plan = APP_PLANS[appSlug]?.find(item => item.id === planId);
  if (!plan) throw new RangeError('Unknown subscription plan');
  const cents = Math.round((interval === 'monthly' ? plan.monthlyUsd : plan.annualUsd) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 2147483647) throw new RangeError('Invalid subscription price');
  return { planId: plan.id, appSlug: plan.appSlug, interval: interval as 'monthly' | 'annual', cents };
}

/** Calendar periods in UTC, clamped to month end (Jan 31 -> Feb 28/29, not March). */
export function subscriptionPeriodEnd(start: Date, interval: 'monthly' | 'annual'): Date {
  if (!Number.isFinite(start.getTime()) || !['monthly', 'annual'].includes(interval)) throw new RangeError('Invalid subscription period');
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + (interval === 'annual' ? 12 : 1));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

/** Only a bound server receipt grants access; legacy status strings are not proof of payment. */
export function subscriptionEntitled(sub: any, receipt: any, now = new Date()): boolean {
  let meta: any;
  try { meta = JSON.parse(receipt?.metadata || '{}'); } catch { return false; }
  const start = sub?.currentPeriodStart instanceof Date ? sub.currentPeriodStart.getTime() : NaN;
  const end = sub?.currentPeriodEnd instanceof Date ? sub.currentPeriodEnd.getTime() : NaN;
  return !!sub && sub.status === 'active' && start <= now.getTime() && now.getTime() < end &&
    receipt?.status === 'completed' && receipt.provider === 'paystack' &&
    ['subscription_charge', 'subscription_renewal'].includes(receipt.type) &&
    receipt.userId === sub.userId && receipt.reference === sub.lastPaymentReference &&
    meta.subscriptionVersion === SUBSCRIPTION_CONTRACT_VERSION && meta.subscriptionId === sub.id &&
    meta.appSlug === sub.appSlug && meta.interval === sub.plan &&
    meta.completion?.periodStart === sub.currentPeriodStart.toISOString() &&
    meta.completion?.periodEnd === sub.currentPeriodEnd.toISOString() &&
    Number.isSafeInteger(receipt.amountUsdCents) && receipt.amountUsdCents > 0 &&
    receipt.amountUsdCents === sub.priceUsdCents;
}

export function matchesSubscriptionPayment(intent: any, metadata: any, data: any, domain: string): boolean {
  return metadata?.subscriptionVersion === SUBSCRIPTION_CONTRACT_VERSION &&
    intent?.provider === 'paystack' && ['subscription_charge', 'subscription_renewal'].includes(intent.type) &&
    data?.status === 'success' && data.currency === 'NGN' && data.domain === domain && metadata.domain === domain &&
    data.reference === intent.reference && Number.isSafeInteger(data.amount) && data.amount > 0 &&
    data.amount === intent.amountNgnKobo && Number.isSafeInteger(intent.amountUsdCents) &&
    intent.amountUsdCents > 0 && intent.amountUsdCents <= 2147483647 &&
    data.customer?.email?.toLowerCase().trim() === metadata.expectedEmail &&
    data.metadata?.transactionId === intent.id && data.metadata?.userId === intent.userId;
}
