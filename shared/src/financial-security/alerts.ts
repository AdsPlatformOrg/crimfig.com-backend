import { createHash } from 'crypto';
import { FINANCIAL_SECURITY_POLICY as policy } from './policy.config';

export type TrustedSecurityEvent = {
  id: string; source: 'executor' | 'provider_reconciler' | 'independent_watchdog';
  kind: 'unmatched_outflow' | 'authorization_bypass' | 'protection_outage';
  environment: 'test' | 'live'; scope: string; observedAt: number;
};
export interface AlertIntent {
  id: string; eventId: string; recipient: string; severity: 'RED' | 'HIGH';
  createdAt: number; submissionDueAt: number; acknowledgementDueAt: number;
  state: 'queued';
}
/** Call only after workload authentication and independent source validation; public errors cannot create incidents. */
export function financialAlertIntents(event: TrustedSecurityEvent, now: number): AlertIntent[] {
  const sourceKinds = { executor: ['authorization_bypass'], provider_reconciler: ['unmatched_outflow'], independent_watchdog: ['protection_outage'] };
  if (!event || !Object.prototype.hasOwnProperty.call(sourceKinds, event.source)
    || !sourceKinds[event.source].includes(event.kind) || !['test', 'live'].includes(event.environment)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id) || !/^[A-Za-z0-9:_-]{1,128}$/.test(event.scope)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(event.observedAt) || event.observedAt <= 0 || event.observedAt > now) throw new Error('Invalid independently sourced event');
  return policy.recipients.map(recipient => ({
    id: createHash('sha256').update(JSON.stringify(['financial-alert-v1', event.environment, event.source, event.id, recipient])).digest('hex'),
    eventId: event.id, recipient, severity: event.kind === 'protection_outage' ? 'HIGH' : 'RED',
    createdAt: now, submissionDueAt: now + policy.alertSubmissionTargetMs,
    acknowledgementDueAt: now + policy.acknowledgementTargetMs, state: 'queued',
  }));
}
export interface AlertLease { id: string; recipient: string; leaseToken: string; environment: 'test' | 'live'; incidentId: string; severity: 'RED' | 'HIGH' }
export interface PriorityAlertStore {
  /** Lease atomically with SKIP LOCKED, an expiry and a unique token. Never hold a DB transaction during email I/O. */
  lease(limit: number, now: number): Promise<AlertLease[]>;
  /** Conditional writes on leaseToken prevent late worker results overwriting a newer lease. */
  accepted(id: string, token: string, providerId: string): Promise<void>;
  failed(id: string, token: string, reason: 'submission_unknown' | 'test_delivery_disabled' | 'recipient_rejected'): Promise<void>;
}
export interface UrgentEmailTransport {
  submit(input: { messageId: string; recipient: string; subject: string; text: string }): Promise<{ providerId: string }>;
}
/** No ordinary error-monitor opt-out/suppression, no sensitive event payload in email, no fake delivery confirmation. */
export class FinancialAlertWorker {
  constructor(private readonly store: PriorityAlertStore, private readonly transport: UrgentEmailTransport,
    private readonly clock: () => number = Date.now) {}
  async tick(): Promise<void> {
    const leases = await this.store.lease(20, this.clock());
    const results = await Promise.allSettled(leases.map(async lease => {
      if (!policy.recipients.includes(lease.recipient)) return this.store.failed(lease.id, lease.leaseToken, 'recipient_rejected');
      if (lease.environment !== 'live') return this.store.failed(lease.id, lease.leaseToken, 'test_delivery_disabled');
      try {
        const result = await this.transport.submit({ messageId: lease.id, recipient: lease.recipient,
          subject: `CrimFig financial security ${lease.severity} alert`,
          text: 'A financial security incident needs your attention. Sign in to the CrimFig administration console to review and acknowledge it. Acknowledgement does not authorize payments or resume withdrawals.' });
        if (!result.providerId) throw new Error('Missing email submission receipt');
        await this.store.accepted(lease.id, lease.leaseToken, result.providerId);
      } catch { await this.store.failed(lease.id, lease.leaseToken, 'submission_unknown'); }
    }));
    // Surface storage failures to the independent watchdog after every other recipient has progressed.
    if (results.some(result => result.status === 'rejected')) throw new Error('Financial alert persistence failed');
  }
}
