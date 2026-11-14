import { createHmac } from 'node:crypto';
import { cpcVisitorContinuity } from '../../../api/ads-api/src/modules/delivery/cpc-visitor-continuity';

describe('CPC visitor continuity', () => {
  const now = 1_790_000_000_000;
  const origin = 'https://publisher.example';
  const subject = 'a'.repeat(32);
  const policy = { origin, issuerSecret: 'b'.repeat(32), continuitySecret: 'c'.repeat(32) };
  function proof(expires: number) {
    const expiry = String(expires);
    const signature = createHmac('sha256', policy.issuerSecret)
      .update(JSON.stringify(['crimfig:cpc-continuity:v1', origin, subject, expiry])).digest('hex');
    return [subject, expiry, signature].join('.');
  }
  const request = { origin, consentState: 'granted' as const, continuityProof: proof(now + 60_000) };

  it('derives a stable key scoped to the campaign from verified permission', () => {
    const key = cpcVisitorContinuity(request, origin, 'campaign-a', policy, now);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(cpcVisitorContinuity({ ...request, continuityProof: proof(now + 120_000) },
      origin, 'campaign-a', policy, now)).toBe(key);
    expect(cpcVisitorContinuity(request, origin, 'campaign-b', policy, now)).not.toBe(key);
  });

  it.each([
    { consentState: 'denied' as const },
    { consentState: 'unknown' as const },
    { privacyControl: true },
    { origin: 'https://other.example' },
    { continuityProof: undefined },
    { continuityProof: proof(now) },
    { continuityProof: proof(now + 300_001) },
    { continuityProof: request.continuityProof.slice(0, -64) + '0'.repeat(64) },
  ])('leaves continuity unknown for %p', (override) => {
    expect(cpcVisitorContinuity({ ...request, ...override }, origin, 'campaign-a', policy, now)).toBeUndefined();
  });

  it('requires publisher approval and independent signing keys', () => {
    expect(cpcVisitorContinuity(request, origin, 'campaign-a', {}, now)).toBeUndefined();
    expect(cpcVisitorContinuity(request, origin, 'campaign-a',
      { ...policy, continuitySecret: policy.issuerSecret }, now)).toBeUndefined();
  });
});
