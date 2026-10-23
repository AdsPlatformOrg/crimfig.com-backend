import { matchesSubscriptionPayment, subscriptionEntitled, subscriptionPeriodEnd, subscriptionPrice } from '../../../api/billing-api/src/modules/subscriptions/subscription-contract';

test.each([
  ['2024-01-31T12:34:56.000Z', 'monthly', '2024-02-29T12:34:56.000Z'],
  ['2025-01-31T12:34:56.000Z', 'monthly', '2025-02-28T12:34:56.000Z'],
  ['2024-02-29T12:34:56.000Z', 'annual', '2025-02-28T12:34:56.000Z'],
  ['2025-12-15T12:34:56.000Z', 'monthly', '2026-01-15T12:34:56.000Z'],
])('calendar period %s %s clamps correctly', (start, interval, expected) => {
  expect(subscriptionPeriodEnd(new Date(start), interval as any).toISOString()).toBe(expected);
});
test('catalog pricing rejects cross-app plan and unsupported interval', () => {
  expect(subscriptionPrice('chat', 'chat_pro', 'monthly').cents).toBe(500);
  expect(subscriptionPrice('chat', 'chat_pro', 'annual').cents).toBe(5000);
  expect(() => subscriptionPrice('ads', 'chat_pro', 'monthly')).toThrow();
  expect(() => subscriptionPrice('chat', 'chat_pro', 'weekly')).toThrow();
});
const start = new Date('2026-01-01T00:00:00Z'), end = new Date('2026-02-01T00:00:00Z');
const sub = { id: 'sub', userId: 'owner', status: 'active', appSlug: 'chat', plan: 'monthly', priceUsdCents: 500,
  currentPeriodStart: start, currentPeriodEnd: end, lastPaymentReference: 'reference', cancelAtPeriodEnd: true };
const meta = { subscriptionVersion: 2, subscriptionId: 'sub', appSlug: 'chat', interval: 'monthly',
  completion: { periodStart: start.toISOString(), periodEnd: end.toISOString() } };
const receipt = { status: 'completed', type: 'subscription_charge', provider: 'paystack', userId: 'owner',
  reference: 'reference', amountUsdCents: 500, metadata: JSON.stringify(meta) };
test('paid period grants access through cancellation but never at/after expiry or before start', () => {
  expect(subscriptionEntitled(sub, receipt, start)).toBe(true);
  expect(subscriptionEntitled(sub, receipt, new Date(end.getTime() - 1))).toBe(true);
  expect(subscriptionEntitled(sub, receipt, end)).toBe(false);
  expect(subscriptionEntitled(sub, receipt, new Date(start.getTime() - 1))).toBe(false);
});
test.each([{ status: 'pending' }, { userId: 'other' }, { reference: 'other' }, { amountUsdCents: 499 },
  { metadata: '{}' }, { metadata: '{bad' }, { type: 'wallet_fund' }, { provider: 'internal' }])('unproven receipt cannot grant entitlement: %j', change => {
  expect(subscriptionEntitled(sub, { ...receipt, ...change }, start)).toBe(false);
});
const intent = { id: 'transaction', userId: 'owner', reference: 'ref', type: 'subscription_charge', provider: 'paystack', amountUsdCents: 500, amountNgnKobo: 50000 };
const binding = { subscriptionVersion: 2, domain: 'test', expectedEmail: 'owner@example.test' };
const data = { status: 'success', currency: 'NGN', domain: 'test', reference: 'ref', amount: 50000,
  customer: { email: 'owner@example.test' }, metadata: { transactionId: 'transaction', userId: 'owner' } };
test('provider success binds amount, currency, domain, reference, email and intent owner', () => {
  expect(matchesSubscriptionPayment(intent, binding, data, 'test')).toBe(true);
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { domain: 'live' }, { reference: 'other' },
    { customer: { email: 'other@example.test' } }, { metadata: { transactionId: 'other', userId: 'owner' } }, { status: 'pending' }]) {
    expect(matchesSubscriptionPayment(intent, binding, { ...data, ...change }, 'test')).toBe(false);
  }
});
