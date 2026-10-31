import { PostgresFinancialAuthority } from '../../../shared/src/financial-security/postgres-authority';

describe('PLAN-0052 authority persistence boundaries', () => {
  function setup() {
    const db = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: jest.fn() };
    const pool = { connect: jest.fn().mockResolvedValue(db) };
    return { db, pool, store: new PostgresFinancialAuthority(pool) };
  }
  test('invalid lease requests do not open a database connection', async () => {
    const s = setup(); await expect(s.store.lease(21, 1000)).rejects.toThrow(); expect(s.pool.connect).not.toHaveBeenCalled();
  });
  test('invalid intent cannot reach database preparation', async () => {
    const s = setup(); await expect(s.store.prepare({} as any)).rejects.toThrow(); expect(s.pool.connect).not.toHaveBeenCalled();
  });
  test('authenticated ingress flood is rejected before nonce insertion', async () => {
    const s = setup(); s.db.query.mockImplementation(async (sql: string) => ({ rowCount: 1, rows: sql.startsWith('SELECT count') ? [{ count: 120 }] : [] }));
    await expect(s.store.consumeWorkloadNonce('billing', 'nonce')).rejects.toThrow('limit');
    expect(s.db.query.mock.calls.some(c => c[0].startsWith('INSERT'))).toBe(false);
  });
  test('proof without a matching pending intent cannot update authorization', async () => {
    const s = setup(); await expect(s.store.attachProof('reference', {} as any, {}, 1000)).rejects.toThrow();
    expect(s.db.query.mock.calls.some(c => c[0].startsWith('UPDATE'))).toBe(false); expect(s.db.query).toHaveBeenCalledWith('ROLLBACK');
  });
  test('work failure rolls back, never commits and releases the connection', async () => {
    const s = setup(); await expect(s.store.transaction(async () => { throw new Error('risk unavailable'); })).rejects.toThrow('risk unavailable');
    expect(s.db.query.mock.calls.some(c => c[0] === 'COMMIT')).toBe(false);
    expect(s.db.query).toHaveBeenCalledWith('ROLLBACK'); expect(s.db.release).toHaveBeenCalledTimes(1);
  });
  test('missing independent assessment fails closed', async () => {
    const s = setup(); await expect(s.store.transaction(tx => tx.assess({} as any))).rejects.toThrow();
    expect(s.db.query).toHaveBeenCalledWith('ROLLBACK');
  });
  test('stale worker lease cannot report provider acceptance', async () => {
    const s = setup(); s.db.query.mockImplementation(async (sql: string) => ({ rows: [], rowCount: sql.startsWith('UPDATE') ? 0 : 1 }));
    await expect(s.store.accepted('alert', 'old-token', 'provider-id')).rejects.toThrow('superseded');
    expect(s.db.query).toHaveBeenCalledWith('ROLLBACK');
  });
  test('critical event failure rolls back incident, both delivery intents and containment together', async () => {
    const s = setup(); s.db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO financial_authority.alert_deliveries')) throw new Error('outbox unavailable');
      return { rows: [], rowCount: 1 };
    });
    await expect(s.store.ingestTrustedEvent({ id: 'event', source: 'provider_reconciler', kind: 'unmatched_outflow', environment: 'test', scope: 'paystack', observedAt: 1000 }, 1000)).rejects.toThrow();
    expect(s.db.query).toHaveBeenCalledWith('ROLLBACK'); expect(s.db.query.mock.calls.some(c => c[0] === 'COMMIT')).toBe(false);
  });
  test('successful event persists both recipients and scoped containment in one transaction', async () => {
    const s = setup(); await s.store.ingestTrustedEvent({ id: 'event', source: 'provider_reconciler', kind: 'unmatched_outflow', environment: 'test', scope: 'paystack', observedAt: 1000 }, 1000);
    const writes = s.db.query.mock.calls.filter(c => c[0].includes('INSERT INTO financial_authority.alert_deliveries'));
    expect(writes).toHaveLength(2); expect(writes.map(c => c[1][2])).toEqual(['jed@crimfig.com', 'jedacctwo@gmail.com']);
    expect(s.db.query.mock.calls.find(c => c[0].includes('INSERT INTO financial_authority.holds'))?.[1][0]).toBe('environment:test');
    expect(s.db.query).toHaveBeenCalledWith('COMMIT'); expect(s.db.release).toHaveBeenCalledTimes(1);
  });
  test('reminder cap or recent notification prevents a repeat email burst', async () => {
    const s = setup(); s.db.query.mockImplementation(async (sql: string) => ({ rowCount: 1,
      rows: sql.startsWith('SELECT i.id') ? [{ id: 'capped', generation: 12, last_notice_ms: 1 }, { id: 'recent', generation: 1, last_notice_ms: 900000 }] : [] }));
    expect(await s.store.escalateUnacknowledged(1000000)).toBe(0);
    expect(s.db.query.mock.calls.some(c => c[0].includes('INSERT INTO financial_authority.alert_deliveries'))).toBe(false);
  });
  test('overdue incident creates one stable reminder round for both recipients without releasing a hold', async () => {
    const s = setup(); s.db.query.mockImplementation(async (sql: string) => ({ rowCount: 1,
      rows: sql.startsWith('SELECT i.id') ? [{ id: 'incident', generation: 0, last_notice_ms: 1, event: { environment: 'test' }, severity: 'RED' }] : [] }));
    expect(await s.store.escalateUnacknowledged(400000)).toBe(1);
    expect(s.db.query.mock.calls.filter(c => c[0].includes('INSERT INTO financial_authority.alert_deliveries'))).toHaveLength(2);
    expect(s.db.query.mock.calls.some(c => c[0].includes('financial_authority.holds'))).toBe(false);
  });
});
