import { ForbiddenException } from '@nestjs/common';

export interface InstanceClaims {
  pageViewId?: string | null;
  slotInstanceId?: string | null;
  opportunityId?: string | null;
  sdkInitId?: string | null;
  instanceIndex?: number | null;
  instancesDetected?: number | null;
}

const identities = ['pageViewId', 'slotInstanceId', 'opportunityId', 'sdkInitId'] as const;

/** Client claims remain untrusted, but cannot relabel an already observed serve.
 * Counts/indexes are changing observations, never identity keys. Legacy omissions
 * remain supported; a later supplied identity may not contradict a known one.
 */
export function assertInstanceBinding(prior: InstanceClaims, incoming: InstanceClaims): void {
  for (const key of identities) {
    if (prior[key] != null && incoming[key] != null && prior[key] !== incoming[key]) {
      throw new ForbiddenException('Serve instance identity changed');
    }
  }
}

/** Retry identity binds event kind and source as well as its authoritative serve.
 * Variable delivery timestamps and geometry/count snapshots are not compared.
 */
export function assertEventReplay(
  prior: InstanceClaims & { serveId?: string | null; type: string; source?: string | null },
  incoming: InstanceClaims & { serveId?: string | null; type: string; source: string },
): void {
  if (prior.serveId !== incoming.serveId || prior.type !== incoming.type ||
      (prior.source != null && prior.source !== incoming.source)) {
    throw new ForbiddenException('Event identity changed');
  }
  assertInstanceBinding(prior, incoming);
}
