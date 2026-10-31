import { FinancialAlertWorker, financialAlertIntents, TrustedSecurityEvent } from '../../../shared/src/financial-security/alerts';

describe('PLAN-0052 priority financial alerts', () => {
  const event: TrustedSecurityEvent = { id: 'event-1', source: 'provider_reconciler', kind: 'unmatched_outflow', environment: 'live', scope: 'paystack:NGN', observedAt: 1000 };
  const leases = financialAlertIntents(event, 1000).map(i => ({ ...i, leaseToken: 'lease', environment: 'live' as const, incidentId: 'incident' }));
  const setup = () => {
    const store = { lease: jest.fn().mockResolvedValue(leases), accepted: jest.fn().mockResolvedValue(undefined), failed: jest.fn().mockResolvedValue(undefined) };
    const transport = { submit: jest.fn().mockResolvedValue({ providerId: 'accepted-1' }) };
    return { store, transport, worker: new FinancialAlertWorker(store, transport, () => 1000) };
  };
  test('rejects source impersonation and invalid event without notification intents', () => {
    expect(() => financialAlertIntents({ ...event, source: 'executor' }, 1000)).toThrow();
    expect(() => financialAlertIntents({ ...event, id: '<script>' }, 1000)).toThrow();
    expect(() => financialAlertIntents({ ...event, observedAt: 1001 }, 1000)).toThrow();
  });
  test('test events never send real email', async () => {
    const { store, transport, worker } = setup();
    store.lease.mockResolvedValue(leases.map(l => ({ ...l, environment: 'test' })));
    await worker.tick(); expect(transport.submit).not.toHaveBeenCalled(); expect(store.accepted).not.toHaveBeenCalled();
    expect(store.failed).toHaveBeenCalledTimes(2);
  });
  test('rejects recipient redirection', async () => {
    const { store, transport, worker } = setup(); store.lease.mockResolvedValue([{ ...leases[0], recipient: 'attacker@example.com' }]);
    await worker.tick(); expect(transport.submit).not.toHaveBeenCalled(); expect(store.accepted).not.toHaveBeenCalled();
  });
  test('one provider failure does not suppress the other owner recipient', async () => {
    const { store, transport, worker } = setup(); transport.submit.mockRejectedValueOnce(new Error('timeout'));
    await worker.tick(); expect(transport.submit).toHaveBeenCalledTimes(2); expect(store.accepted).toHaveBeenCalledTimes(1);
    expect(store.failed).toHaveBeenCalledWith(leases[0].id, 'lease', 'submission_unknown');
  });
  test('storage failure surfaces only after the other recipient progresses', async () => {
    const { store, transport, worker } = setup(); transport.submit.mockRejectedValueOnce(new Error('timeout')); store.failed.mockRejectedValueOnce(new Error('database down'));
    await expect(worker.tick()).rejects.toThrow('persistence'); expect(store.accepted).toHaveBeenCalledTimes(1);
  });
  test('creates stable simultaneous owner intents with configured targets', () => {
    const intents = financialAlertIntents(event, 1000);
    expect(intents.map(i => i.recipient)).toEqual(['jed@crimfig.com', 'jedacctwo@gmail.com']);
    expect(intents.map(i => i.id)).toEqual(financialAlertIntents(event, 2000).map(i => i.id));
    expect(intents[0]).toMatchObject({ state: 'queued', severity: 'RED', submissionDueAt: 11_000, acknowledgementDueAt: 301_000 });
  });
  test('records provider acceptance, not delivered or human acknowledgement', async () => {
    const { store, transport, worker } = setup(); await worker.tick(); expect(store.accepted).toHaveBeenCalledTimes(2);
    expect(transport.submit.mock.calls[0][0].messageId).toBe(leases[0].id);
  });
});
