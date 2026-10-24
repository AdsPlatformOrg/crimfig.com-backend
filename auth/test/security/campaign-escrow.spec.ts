import { Test } from '@nestjs/testing';
import { BillingEcosystemClient } from '../../../api/ads-api/src/modules/billing/billing-ecosystem.client';
import { WalletService } from '../../../api/billing-api/src/modules/wallet/wallet.service';
import { DeferredAuditService as EmbedAuditService } from '../../../api/ads-api/src/modules/verification/deferred-audit.service';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as schema from '@crimfig/database/schema';
import { CampaignEscrowService } from '../../../api/billing-api/src/modules/ecosystem/campaign-escrow.service';
import { AdsSettlementService } from '../../../api/ads-api/src/modules/billing/ads-settlement.service';
import { DeferredAuditService } from '../../../api/ads-api/src/modules/billing/deferred-audit.service';
import { EcosystemController } from '../../../api/billing-api/src/modules/ecosystem/ecosystem.controller';

const owner = '12345678-1234-4234-8234-123456789001';
const campaignId = '12345678-1234-4234-8234-123456789002';
const secondCampaign = '12345678-1234-4234-8234-123456789003';
const stranger = '12345678-1234-4234-8234-123456789004';
/** Transactional in-memory adapter executes service branches and rolls back injected failures.
 * It records real Drizzle SQL predicates/locks, but does NOT emulate PostgreSQL's lock manager.
 * A real multi-connection PostgreSQL run remains a deployment gate.
 */
function database(balance = 2000) {
  const dialect = new PgDialect();
  let state: any = {
    campaigns: [campaignId, secondCampaign].map(id => ({ id, advertiserId: owner, status: 'draft', moderationStatus: 'approved', remainingBudgetUsdCents: 1000 })),
    escrows: [], wallets: [{ id: 'wallet', userId: owner, balanceUsdCents: balance, lockedUsdCents: 0, version: 0 }], receipts: [],
  };
  const tables = new Map<any, string>([[schema.adsCampaigns, 'campaigns'], [schema.adsCampaignEscrows, 'escrows'], [schema.billingWallets, 'wallets'], [schema.billingTransactions, 'receipts']]);
  const locks: string[] = [], queries: any[] = [];
  let tail = Promise.resolve();
  let fail: string | undefined;
  const match = (row: any, predicate: any) => {
    const query = dialect.sqlToQuery(predicate); queries.push(query);
    const fields: Record<string, string> = { id: 'id', campaign_id: 'campaignId', advertiser_id: 'advertiserId', user_id: 'userId', idempotency_key: 'idempotencyKey' };
    const names = [...query.sql.matchAll(/"([a-z_]+)" = \$[0-9]+/g)].map(found => fields[found[1]]);
    return names.every((name, index) => row[name] === query.params[index]);
  };
  const db: any = { transaction: async (work: any, options: any) => {
    expect(options.isolationLevel).toBe('read committed');
    const previous = tail; let release: () => void = () => {};
    tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const before = structuredClone(state);
    const tx: any = {
      execute: async (query: any) => { locks.push(dialect.sqlToQuery(query).sql); },
      select: () => {
        let table: any, predicate: any;
        const run = () => structuredClone(state[tables.get(table)!].filter((row: any) => match(row, predicate)));
        const chain: any = { from: (value: any) => { table = value; return chain; }, where: (value: any) => { predicate = value; return chain; },
          for: async (mode: string) => { expect(mode).toBe('update'); return run(); }, then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject) };
        return chain;
      },
      insert: (table: any) => ({ values: (values: any) => {
        const name = tables.get(table)!;
        const run = () => {
          if (fail === name) { fail = undefined; throw new Error('injected storage failure'); }
          const row = { id: `${name}-${state[name].length + 1}`, ...values }; state[name].push(row); return structuredClone([row]);
        };
        return { returning: async () => run(), onConflictDoNothing: async () => { if (!state[name].some((row: any) => row.userId === values.userId)) run(); } };
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
    };
    try { return await work(tx); } catch (error) { state = before; throw error; } finally { release(); }
  } };
  return { db, state: () => state, locks, queries, fail: (name: string) => { fail = name; } };
}

test('duplicate/concurrent reservation returns the same durable receipt and only moves funds once', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  const results = await Promise.all([service.change(owner, campaignId, 'reserve', 1000), service.change(owner, campaignId, 'reserve', 1000)]);
  expect(results.map(result => result.replayed)).toEqual([false, true]);
  expect(results[0].transactionId).toBe(results[1].transactionId);
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 1000, lockedUsdCents: 1000 });
  expect(store.state().receipts).toHaveLength(1);
  expect(store.locks.some(statement => statement.includes('pg_advisory_xact_lock'))).toBe(true);
});
test('lost-response retry releases once; repeated reserve/release cycles retain cumulative accounting', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', 1000);
  const released = await service.change(owner, campaignId, 'release');
  expect((await service.change(owner, campaignId, 'release')).transactionId).toBe(released.transactionId);
  const resumed = await service.change(owner, campaignId, 'reserve', 1000);
  expect(resumed.escrow).toMatchObject({ allocatedUsdCents: 2000, refundedUsdCents: 1000, consumedUsdCents: 0 });
  expect(resumed.operationId).not.toBe(released.operationId);
  await service.change(owner, campaignId, 'release');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 2000, lockedUsdCents: 0 });
  expect(store.state().receipts).toHaveLength(4);
});
test.each(['escrows', 'wallets', 'receipts', 'campaigns'])('storage failure at %s rolls back reservation, wallet, receipt and activation together', async failure => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  store.fail(failure);
  await expect(service.change(owner, campaignId, 'reserve', undefined, 'active')).rejects.toThrow('injected');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 2000, lockedUsdCents: 0 });
  expect(store.state().escrows).toHaveLength(0); expect(store.state().receipts).toHaveLength(0);
  expect(store.state().campaigns[0].status).toBe('draft');
  await service.change(owner, campaignId, 'reserve', undefined, 'active');
  expect(store.state().campaigns[0].status).toBe('active');
});
test('activation and pause are serialized with reservation; manual release cannot leave active campaign unfunded', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', undefined, 'active');
  await expect(service.change(owner, campaignId, 'release')).rejects.toBeInstanceOf(ConflictException);
  await Promise.all([service.change(owner, campaignId, 'release', undefined, 'paused'), service.change(owner, campaignId, 'reserve', undefined, 'active')]);
  expect(store.state().campaigns[0].status).toBe('active');
  expect(store.state().escrows[0].status).toBe('active');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 1000, lockedUsdCents: 1000 });
});
test('two campaigns cannot reserve more than the shared wallet', async () => {
  const store = database(1500); const service = new CampaignEscrowService(store.db);
  const results = await Promise.allSettled([service.change(owner, campaignId, 'reserve', 1000), service.change(owner, secondCampaign, 'reserve', 1000)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 500, lockedUsdCents: 1000 });
});
test('foreign owner rejected before creating wallet or receipt', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await expect(service.change(stranger, campaignId, 'reserve', 1000)).rejects.toBeInstanceOf(NotFoundException);
  expect(store.state().escrows).toHaveLength(0); expect(store.state().receipts).toHaveLength(0);
});
test('legacy unreceipted escrow and duplicate escrow rows fail closed for reconciliation', async () => {
  for (const duplicate of [false, true]) {
    const store = database(); const service = new CampaignEscrowService(store.db);
    store.state().escrows.push({ id: 'legacy', userId: owner, campaignId, allocatedUsdCents: 1000, consumedUsdCents: 0, refundedUsdCents: 0, status: 'active' });
    if (duplicate) store.state().escrows.push({ ...store.state().escrows[0], id: 'duplicate' });
    await expect(service.change(owner, campaignId, 'release')).rejects.toBeInstanceOf(ConflictException);
    expect(store.state().wallets[0].balanceUsdCents).toBe(2000); expect(store.state().receipts).toHaveLength(0);
  }
});
test('active reservation resizing, unapproved activation and wallet underflow are rejected', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', 1000);
  await expect(service.change(owner, campaignId, 'reserve', 500)).rejects.toBeInstanceOf(ConflictException);
  store.state().campaigns[0].moderationStatus = 'pending_primary_review';
  await expect(service.change(owner, campaignId, 'reserve', undefined, 'active')).rejects.toBeInstanceOf(ConflictException);
  store.state().wallets[0].lockedUsdCents = 999;
  await expect(service.change(owner, campaignId, 'release')).rejects.toBeInstanceOf(ConflictException);
  expect(store.state().escrows[0].status).toBe('active');
});
test('unfunded draft may pause without a fabricated monetary receipt', async () => {
  const store = database(); const result = await new CampaignEscrowService(store.db).change(owner, campaignId, 'release', undefined, 'paused');
  expect(result).toMatchObject({ escrow: null, operationId: null, transactionId: null, campaign: { status: 'paused' } });
  expect(store.state().receipts).toHaveLength(0);
});
test('legacy settlement, clearance, unrelated rebates and simulated penalties cannot mutate money', async () => {
  const db = { select: jest.fn(), insert: jest.fn(), update: jest.fn() }, billing = { creditEarnings: jest.fn() };
  const settlement = new AdsSettlementService(db as any, billing as any);
  const audit = new DeferredAuditService(db as any, billing as any);
  for (const action of [() => settlement.processPendingSettlement(), () => audit.graduateClearedEarnings(), () => audit.runTier2DeepMacroAudit(), () => audit.runTier3ExtendedAudit('tier3_15d')]) {
    await expect(action()).rejects.toBeInstanceOf(ServiceUnavailableException);
  }
  expect(db.select).not.toHaveBeenCalled(); expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(billing.creditEarnings).not.toHaveBeenCalled();
});
test('internal key is required for new escrow routes and legacy generic writes remain unavailable', async () => {
  const previous = process.env.INTERNAL_ECOSYSTEM_KEY;
  try {
    process.env.INTERNAL_ECOSYSTEM_KEY = 'fixture-key';
    const money = { change: jest.fn(async () => ({ receipt: 'confirmed' })) };
    const controller = new EcosystemController({} as any, money as any);
    await expect(controller.reserveCampaign(owner, campaignId, 'wrong', { amountUsdCents: 1000, reason: 'test' })).rejects.toThrow('authorization');
    expect(money.change).not.toHaveBeenCalled();
    await expect(controller.reserveCampaign(owner, campaignId, 'fixture-key', { amountUsdCents: 1000, reason: 'test' })).resolves.toMatchObject({ status: 'success' });
    for (const method of ['lockFunds', 'unlockFunds', 'deductSpend', 'creditEarning']) {
      await expect((controller as any)[method](owner, 'fixture-key', { amountUsdCents: 1000 })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  } finally { if (previous === undefined) delete process.env.INTERNAL_ECOSYSTEM_KEY; else process.env.INTERNAL_ECOSYSTEM_KEY = previous; }
});

test('receipt storage failure during release preserves the active reservation and locked wallet', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', undefined, 'active'); store.fail('receipts');
  await expect(service.change(owner, campaignId, 'release', undefined, 'paused')).rejects.toThrow('injected');
  expect(store.state().campaigns[0].status).toBe('active'); expect(store.state().escrows[0].status).toBe('active');
  expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 1000, lockedUsdCents: 1000 });
  expect(store.state().receipts).toHaveLength(1);
});
test('malformed receipt metadata cannot authorize a reservation replay or release', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', 1000);
  store.state().receipts[0].metadata = JSON.stringify({ version: 2, campaignId: secondCampaign });
  await expect(service.change(owner, campaignId, 'release')).rejects.toBeInstanceOf(ConflictException);
  expect(store.state().wallets[0].lockedUsdCents).toBe(1000);
});

test('HTTP Billing boundary returns committed receipts to the real Ads client without providers', async () => {
  const previous = process.env.INTERNAL_ECOSYSTEM_KEY;
  let app: any;
  try {
    process.env.INTERNAL_ECOSYSTEM_KEY = 'http-fixture-key';
    const store = database();
    const module = await Test.createTestingModule({ controllers: [EcosystemController], providers: [
      { provide: WalletService, useValue: {} },
      { provide: CampaignEscrowService, useValue: new CampaignEscrowService(store.db) },
    ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const client = new BillingEcosystemClient({ get: (key: string) => ({ INTERNAL_ECOSYSTEM_KEY: 'http-fixture-key', BILLING_API_URL: `http://127.0.0.1:${address.port}` } as any)[key] } as any);
    await client.reserveCampaignEscrow(owner, campaignId, 1000);
    await client.reserveCampaignEscrow(owner, campaignId, 1000);
    expect((await client.changeCampaignStatus(owner, campaignId, 'active')).status).toBe('active');
    expect((await client.changeCampaignStatus(owner, campaignId, 'paused')).status).toBe('paused');
    await client.releaseCampaignEscrow(owner, campaignId);
    expect(store.state().receipts).toHaveLength(2);
    expect(store.state().wallets[0]).toMatchObject({ balanceUsdCents: 2000, lockedUsdCents: 0 });
  } finally {
    if (app) await app.close();
    if (previous === undefined) delete process.env.INTERNAL_ECOSYSTEM_KEY; else process.env.INTERNAL_ECOSYSTEM_KEY = previous;
  }
}, 30000);
test('public embed pings update diagnostics without auto-verifying websites/apps or running settlement', async () => {
  const rows: any[][] = [
    [{ id: 'audit', websiteId: 'website', domain: 'example.com', appId: 'app', runTimestamp: new Date() }],
    [{ id: 'website', domain: 'example.com', verificationStatus: 'pending' }],
    [{ id: 'app', verificationStatus: 'pending' }], [],
  ];
  const updates: any[] = [];
  const db: any = {
    select: () => {
      const result = rows.shift();
      const chain: any = { from: () => chain, where: () => chain, limit: async () => result, groupBy: async () => result };
      return chain;
    },
    update: () => ({ set: (values: any) => { updates.push(values); return { where: async () => [] }; } }),
  };
  const settlement = { processPendingSettlement: jest.fn() };
  await new EmbedAuditService(db, settlement as any).handleDeferredAuditCron();
  expect(updates).toEqual([expect.objectContaining({ embedPingLastAt: expect.any(Date) }), { isProcessed: true, auditFlags: null }]);
  expect(updates.every(values => !('verificationStatus' in values) && !('verifiedAt' in values))).toBe(true);
  expect(settlement.processPendingSettlement).not.toHaveBeenCalled();
});

test('trashed campaign cannot use an existing receipt to bypass activation rules', async () => {
  const store = database(); const service = new CampaignEscrowService(store.db);
  await service.change(owner, campaignId, 'reserve', 1000);
  store.state().campaigns[0].status = 'trash';
  await expect(service.change(owner, campaignId, 'reserve', undefined, 'active')).rejects.toBeInstanceOf(ConflictException);
  expect(store.state().campaigns[0].status).toBe('trash'); expect(store.state().receipts).toHaveLength(1);
});
