import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '@crimfig/database/schema';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';
import { WebhooksService } from '../../../api/billing-api/src/modules/webhooks/webhooks.service';
import { PaystackService } from '../../../api/billing-api/src/modules/providers/paystack.service';
const owner = 'owner';
const requestId = '12345678-1234-4234-8234-123456789099';
const intent = { id: 'intent', userId: owner, reference: 'crimfig-fund-fixture', type: 'wallet_fund', provider: 'paystack', status: 'pending',
  amountUsdCents: 500, amountNgnKobo: 50000, idempotencyKey: null,
  metadata: JSON.stringify({ fundingVersion: 2, expectedEmail: 'owner@example.test', saveCard: false }) };
const proof = () => ({ reference: intent.reference, status: 'success', currency: 'NGN', domain: 'test', amount: 50000,
  metadata: { transactionId: intent.id, userId: owner }, customer: { email: 'owner@example.test' } });
const provider = () => ({ paymentDomain: () => 'test', verifyWebhookSignature: () => true,
  verifyTransaction: jest.fn(async () => proof()), initializeTransaction: jest.fn(), chargeAuthorization: jest.fn() });
const fx = { getUsdToNgnRate: async () => ({ rateId: 'persisted-quote', rate: 100 }),
  convertUsdCentsToNgn: async (cents: number) => ({ ngnKobo: cents * 100 }) };
// Adapter asserts real Drizzle predicates, receipt states and rollback. It is not a PostgreSQL lock-manager test.
function database(balance = 0) {
  const dialect = new PgDialect();
  let state: any = { intents: [{ ...intent }], wallets: [{ id: 'wallet', userId: owner, balanceUsdCents: balance, lockedUsdCents: 0, version: 0 }], cards: [], events: [] };
  const tables = new Map<any, string>([[schema.billingTransactions, 'intents'], [schema.billingWallets, 'wallets'], [schema.billingSavedCards, 'cards'], [schema.billingProviderEvents, 'events']]);
  const locks: string[] = [], queries: any[] = [];
  let tail = Promise.resolve();
  let fail: string | undefined;
  const match = (row: any, predicate: any) => {
    const query = dialect.sqlToQuery(predicate); queries.push(query);
    const fields: Record<string, string> = { id: 'id', campaign_id: 'campaignId', advertiser_id: 'advertiserId', user_id: 'userId', idempotency_key: 'idempotencyKey', reference: 'reference', provider: 'provider', type: 'type', signature: 'signature' };
    const names = [...query.sql.matchAll(/"([a-z_]+)" = \$[0-9]+/g)].map(found => fields[found[1]]);
    return names.every((name, index) => row[name] === query.params[index]);
  };
  const operations = () => ({
      execute: async (query: any) => { locks.push(dialect.sqlToQuery(query).sql); },
      select: () => {
        let table: any, predicate: any;
        const run = () => structuredClone(state[tables.get(table)!].filter((row: any) => match(row, predicate)));
        const chain: any = { from: (value: any) => { table = value; return chain; }, where: (value: any) => { predicate = value; return chain; },
          limit: async () => run(), for: async (mode: string) => { expect(mode).toBe('update'); return run(); }, then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject) };
        return chain;
      },
      insert: (table: any) => ({ values: (values: any) => {
        const name = tables.get(table)!;
        const run = () => {
          if (fail === name) { fail = undefined; throw new Error('injected storage failure'); }
          const row = { id: `${name}-${state[name].length + 1}`, ...values }; state[name].push(row); return structuredClone([row]);
        };
        return { returning: async () => run(), onConflictDoNothing: async () => { if (!state[name].some((row: any) => name === 'wallets' ? row.userId === values.userId : row.reference === values.reference && row.provider === values.provider)) run(); }, then: (resolve: any, reject: any) => { try { return Promise.resolve(run()).then(resolve, reject); } catch (error) { return Promise.reject(error).then(resolve, reject); } } };
      } }),
      update: (table: any) => ({ set: (values: any) => ({ where: (predicate: any) => {
        const run = () => {
          const name = tables.get(table)!;
          if (fail === name) { fail = undefined; throw new Error('injected storage failure'); }
          const rows = state[name].filter((row: any) => match(row, predicate));
          for (const row of rows) Object.assign(row, { ...values, ...(name === 'wallets' ? { version: row.version + 1 } : {}) });
          return structuredClone(rows);
        };
        return { returning: async () => run(), then: (resolve: any, reject: any) => { try { return Promise.resolve(run()).then(resolve, reject); } catch (error) { return Promise.reject(error).then(resolve, reject); } } };
      } }) }),
  });
  const db: any = { ...operations(), transaction: async (work: any, options: any) => {
    expect(options.isolationLevel).toBe('read committed');
    const previous = tail; let release: () => void = () => {};
    tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const before = structuredClone(state);
    try { return await work(operations()); } catch (error) { state = before; throw error; } finally { release(); }
  } };
  return { db, state: () => state, locks, queries, fail: (name: string) => { fail = name; } };
}

test('duplicate and concurrent confirmations credit once and store balance audit snapshots', async () => {
  const store = database(); const service = new WalletService(store.db, fx as any, provider() as any);
  await Promise.all([service.completeSuccessfulFunding(intent.id, proof()), service.completeSuccessfulFunding(intent.id, proof())]);
  await service.completeSuccessfulFunding(intent.id, proof());
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 500, version: 1 });
  expect(store.state().intents[0]).toMatchObject({ status: 'completed', idempotencyKey: 'wallet-fund:v2:intent', balanceBeforeUsdCents: 0, balanceAfterUsdCents: 500 });
  expect(store.locks.some(query => query.includes('pg_advisory_xact_lock'))).toBe(true);
});
test.each(['wallets', 'intents'])('failure writing %s rolls back credit and completed receipt; retry is safe', async table => {
  const store = database(); const service = new WalletService(store.db, fx as any, provider() as any); store.fail(table);
  await expect(service.completeSuccessfulFunding(intent.id, proof())).rejects.toThrow('injected');
  expect(store.state().wallets[0].balanceUsdCents).toBe(0); expect(store.state().intents[0].status).toBe('pending');
  await service.completeSuccessfulFunding(intent.id, proof()); expect(store.state().wallets[0].balanceUsdCents).toBe(500);
});
test.each([
  { reference: 'foreign' }, { currency: 'USD' }, { domain: 'live' }, { amount: 49999 }, { amount: '50000' },
  { status: 'pending' }, { metadata: { userId: 'other', transactionId: intent.id } },
  { metadata: { userId: owner, transactionId: 'other' } }, { metadata: null }, { customer: { email: 'other@example.test' } },
])('mismatched proof cannot complete or credit: %j', async change => {
  const store = database();
  await expect(new WalletService(store.db, fx as any, provider() as any).completeSuccessfulFunding(intent.id, { ...proof(), ...change })).rejects.toBeInstanceOf(ConflictException);
  expect(store.state().wallets[0].balanceUsdCents).toBe(0); expect(store.state().intents[0].status).toBe('pending');
});
test('wallet overflow, wrong intent type and legacy pending rows require reconciliation', async () => {
  for (const reason of ['overflow', 'type', 'legacy', 'failed']) {
    const store = database(reason === 'overflow' ? 2147483647 : 0);
    if (reason === 'type') store.state().intents[0].type = 'subscription_charge';
    if (reason === 'legacy') store.state().intents[0].metadata = '{}';
    if (reason === 'failed') store.state().intents[0].status = 'failed';
    await expect(new WalletService(store.db, fx as any, provider() as any).completeSuccessfulFunding(intent.id, proof())).rejects.toBeInstanceOf(ConflictException);
    expect(store.state().wallets[0].balanceUsdCents).toBe(reason === 'overflow' ? 2147483647 : 0);
  }
});
test('missing wallet created atomically rather than completing without a credit', async () => {
  const store = database(); store.state().wallets = [];
  await new WalletService(store.db, fx as any, provider() as any).completeSuccessfulFunding(intent.id, proof());
  expect(store.state().wallets[0].balanceUsdCents).toBe(500);
});
test('owner verification and signed callbacks converge on the same receipt', async () => {
  const store = database(), paystack = provider();
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  const webhook = new WebhooksService(store.db, paystack as any, wallet);
  const payload = JSON.stringify({ event: 'charge.success', data: proof() });
  await Promise.all([wallet.verifyFunding(intent.reference, owner), webhook.handlePaystackWebhook(payload, 'fixture')]);
  await webhook.handlePaystackWebhook(payload, 'fixture');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 500, version: 1 });
  expect(store.state().events).toHaveLength(1); expect(store.state().events[0].processed).toBe(true);
});
test('callback acknowledgement storage failure after commit retries without another wallet credit', async () => {
  const store = database(), paystack = provider();
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  const webhook = new WebhooksService(store.db, paystack as any, wallet);
  store.state().events.push({ provider: 'paystack', reference: `charge.success:${intent.reference}`, processed: false });
  store.fail('events'); const payload = JSON.stringify({ event: 'charge.success', data: proof() });
  await expect(webhook.handlePaystackWebhook(payload, 'fixture')).rejects.toThrow('injected');
  expect(store.state().wallets[0].balanceUsdCents).toBe(500);
  await webhook.handlePaystackWebhook(payload, 'fixture');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 500, version: 1 }); expect(store.state().events[0].processed).toBe(true);
});
test('unknown intent and subscription charge are not silently acknowledged or activated', async () => {
  const store = database(), paystack = provider(); const wallet = new WalletService(store.db, fx as any, paystack as any);
  const webhook = new WebhooksService(store.db, paystack as any, wallet);
  await expect(webhook.handlePaystackWebhook(JSON.stringify({ event: 'charge.success', data: { ...proof(), reference: 'unknown' } }), 'fixture')).rejects.toBeInstanceOf(ServiceUnavailableException);
  store.state().intents[0].type = 'subscription_charge';
  await expect(webhook.handlePaystackWebhook(JSON.stringify({ event: 'charge.success', data: proof() }), 'fixture')).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(store.state().wallets[0].balanceUsdCents).toBe(0); expect(store.state().events).toHaveLength(0);
});
test('non-success verification is pending and cannot overwrite a concurrent completed receipt', async () => {
  const store = database(), paystack = provider(); const wallet = new WalletService(store.db, fx as any, paystack as any);
  paystack.verifyTransaction.mockImplementation(async () => { await wallet.completeSuccessfulFunding(intent.id, proof()); return { ...proof(), status: 'pending' }; });
  expect((await wallet.verifyFunding(intent.reference, owner)).status).toBe('pending');
  expect(store.state().intents[0].status).toBe('completed'); expect(store.state().wallets[0].balanceUsdCents).toBe(500);
});
const card = { reusable: true, channel: 'card', authorization_code: 'fixture-only-token', signature: 'fixture-fingerprint', last4: '1234', exp_month: '12', exp_year: '2030', brand: 'visa' };
test('card storage requires explicit consent, and retry deduplicates independently of wallet credit', async () => {
  const store = database(), wallet = new WalletService(store.db, fx as any, provider() as any);
  await wallet.completeSuccessfulFunding(intent.id, { ...proof(), authorization: card }); expect(store.state().cards).toHaveLength(0);
  store.state().intents[0].metadata = JSON.stringify({ ...JSON.parse(store.state().intents[0].metadata), saveCard: true });
  await wallet.completeSuccessfulFunding(intent.id, { ...proof(), authorization: card });
  await wallet.completeSuccessfulFunding(intent.id, { ...proof(), authorization: card });
  expect(store.state().cards).toHaveLength(1); expect(store.state().wallets[0].balanceUsdCents).toBe(500);
});
test('optional card storage failure cannot undo or repeat a committed credit', async () => {
  const store = database(); store.state().intents[0].metadata = JSON.stringify({ fundingVersion: 2, expectedEmail: 'owner@example.test', saveCard: true }); store.fail('cards');
  const wallet = new WalletService(store.db, fx as any, provider() as any);
  await wallet.completeSuccessfulFunding(intent.id, { ...proof(), authorization: card });
  expect(store.state().wallets[0].balanceUsdCents).toBe(500); expect(store.state().cards).toHaveLength(0);
  await wallet.completeSuccessfulFunding(intent.id, { ...proof(), authorization: card });
  expect(store.state().wallets[0].version).toBe(1); expect(store.state().cards).toHaveLength(1);
});
test('funding intent exists with final reference before provider initialization or early callback', async () => {
  const store = database(), paystack = provider(); const wallet = new WalletService(store.db, fx as any, paystack as any);
  paystack.initializeTransaction.mockImplementation(async (params: any) => {
    const saved = store.state().intents.find((row: any) => row.reference === params.reference);
    expect(saved).toMatchObject({ status: 'pending', amountNgnKobo: 50000 });
    await wallet.completeSuccessfulFunding(saved.id, { ...proof(), reference: saved.reference, metadata: params.metadata });
    return { reference: params.reference, authorization_url: 'https://checkout.paystack.com/fixture', access_code: 'fixture' };
  });
  const result = await wallet.initializeFunding({ requestId, userId: owner, userEmail: 'owner@example.test', amountUsd: 5 });
  expect(result.reference).toMatch(/^crimfig-fund-/); expect(store.state().wallets[0].balanceUsdCents).toBe(500);
  expect(result).toMatchObject({ status: 'completed', checkoutReady: false });
  expect(JSON.parse(store.state().intents.at(-1).metadata).initialization.state).toBe('ready');
  expect(await wallet.recoverFundingRequest(owner, requestId)).toMatchObject({ status: 'completed', checkoutReady: false });
  expect(store.state().wallets[0].version).toBe(1);
});
test('ambiguous initialization stays pending; no saved-card fallback or automatic payment retry', async () => {
  const store = database(), paystack = provider(); const wallet = new WalletService(store.db, fx as any, paystack as any);
  paystack.initializeTransaction.mockRejectedValue(new Error('network timeout'));
  await expect(wallet.initializeFunding({ requestId, userId: owner, userEmail: 'owner@example.test', amountUsd: 5 })).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(store.state().intents.at(-1).status).toBe('pending'); expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
  await expect(wallet.initializeFunding({ requestId, userId: owner, userEmail: 'owner@example.test', amountUsd: 5, savedCardId: 'saved' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(paystack.chargeAuthorization).not.toHaveBeenCalled(); expect(store.state().wallets[0].balanceUsdCents).toBe(0);
});
test.each([NaN, Infinity, -1, 0.99, 1.001, 21474836.48])('invalid USD amount %s never initializes a payment', async amountUsd => {
  const store = database(), paystack = provider();
  await expect(new WalletService(store.db, fx as any, paystack as any).initializeFunding({ requestId, userId: owner, userEmail: 'owner@example.test', amountUsd })).rejects.toThrow();
  expect(paystack.initializeTransaction).not.toHaveBeenCalled(); expect(store.state().intents).toHaveLength(1);
});
test('provider transport sends stored reference and NGN currency once, rejecting missing keys/test keys in production', async () => {
  const previousKey = process.env.PAYSTACK_SECRET_KEY, previousMode = process.env.NODE_ENV, originalFetch = global.fetch;
  try {
    delete process.env.PAYSTACK_SECRET_KEY; expect(() => new PaystackService().paymentDomain()).toThrow();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture'; process.env.NODE_ENV = 'production'; expect(() => new PaystackService().paymentDomain()).toThrow();
    process.env.NODE_ENV = 'test';
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: true, data: { reference: intent.reference } }) })); global.fetch = fetch as any;
    await new PaystackService().initializeTransaction({ email: 'owner@example.test', amountKobo: 50000, reference: intent.reference });
    expect(fetch).toHaveBeenCalledTimes(1); const options = (fetch.mock.calls as any)[0][1];
    expect(options).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) }); expect(JSON.parse(options.body)).toMatchObject({ currency: 'NGN', reference: intent.reference, amount: 50000 });
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.PAYSTACK_SECRET_KEY; else process.env.PAYSTACK_SECRET_KEY = previousKey;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
  }
});

const initializeInput = { requestId, userId: owner, userEmail: 'owner@example.test', amountUsd: 5, saveCard: false };
const checkoutSession = (reference: string) => ({ reference, authorization_url: 'https://checkout.paystack.com/fixture', access_code: 'fixture' });
test('concurrent or repeated initialization requests create one intent and one provider call', async () => {
  const store = database(), paystack = provider();
  paystack.initializeTransaction.mockImplementation(async (input: any) => checkoutSession(input.reference));
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  const results = await Promise.all([wallet.initializeFunding(initializeInput), wallet.initializeFunding(initializeInput)]);
  expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1); expect(results[0].reference).toBe(results[1].reference);
  const recovered = await wallet.initializeFunding(initializeInput);
  expect(recovered.checkoutReady).toBe(true); expect(recovered.authorizationUrl).toBe('https://checkout.paystack.com/fixture');
  expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1); expect(store.state().intents).toHaveLength(2);
});
test('recovery is owner-scoped, does not requote or call provider, and preserves original checkout', async () => {
  const store = database(), paystack = provider(); paystack.initializeTransaction.mockImplementation(async (input: any) => checkoutSession(input.reference));
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  const first = await wallet.initializeFunding(initializeInput);
  const restored = new WalletService(store.db, { getUsdToNgnRate: () => { throw Error('must not requote'); } } as any, paystack as any);
  expect((await restored.recoverFundingRequest(owner, requestId)).reference).toBe(first.reference);
  expect((await restored.initializeFunding(initializeInput)).amountNgn).toBe(first.amountNgn);
  await expect(restored.recoverFundingRequest('another-owner', requestId)).rejects.toThrow('not found');
  expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
});
test('same request ID rejects changed amount, consent or email rather than creating another payment', async () => {
  const store = database(), paystack = provider(); paystack.initializeTransaction.mockImplementation(async (input: any) => checkoutSession(input.reference));
  const wallet = new WalletService(store.db, fx as any, paystack as any); await wallet.initializeFunding(initializeInput);
  for (const change of [{amountUsd:6}, {saveCard:true}, {userEmail:'new@example.test'}]) await expect(wallet.initializeFunding({...initializeInput,...change})).rejects.toBeInstanceOf(ConflictException);
  expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
});
test('ambiguous provider response is durable and never automatically re-initialized', async () => {
  const store = database(), paystack = provider(); paystack.initializeTransaction.mockRejectedValue(new Error('lost response'));
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  await expect(wallet.initializeFunding(initializeInput)).rejects.toBeInstanceOf(ServiceUnavailableException);
  const restored = await wallet.recoverFundingRequest(owner, requestId);
  expect(restored.checkoutReady).toBe(false); expect(restored.status).toBe('pending');
  const repeated = await wallet.initializeFunding(initializeInput); expect(repeated.reference).toBe(restored.reference);
  expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
});
test('checkout storage failure after provider acceptance retains claim and prevents provider replay', async () => {
  const store = database(), paystack = provider(); paystack.initializeTransaction.mockImplementation(async (input: any) => { store.fail('intents'); return checkoutSession(input.reference); });
  const wallet = new WalletService(store.db, fx as any, paystack as any);
  await expect(wallet.initializeFunding(initializeInput)).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect((await wallet.initializeFunding(initializeInput)).checkoutReady).toBe(false); expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
});
test('invalid request identity is rejected before provider or quote work', async () => {
  const store = database(), paystack = provider(); const wallet = new WalletService(store.db, fx as any, paystack as any);
  for (const request of ['', 'not-a-uuid', undefined]) await expect(wallet.initializeFunding({...initializeInput,requestId:request as any})).rejects.toThrow('UUID');
  expect(paystack.initializeTransaction).not.toHaveBeenCalled(); expect(store.state().intents).toHaveLength(1);
});
