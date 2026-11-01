import { resolveClientIp, resolveClaimedIp } from '../../../api/ads-api/src/modules/delivery/client-ip';

const req = (headers: Record<string, string>, remote = '10.0.0.9') =>
  ({ headers, socket: { remoteAddress: remote } }) as any;

describe('PLAN-0066 F1 trusted client IP resolution', () => {
  // Rejection / spoofing cases first
  it('ignores a spoofed left-most x-forwarded-for entry (uses proxy-appended right-most)', () => {
    expect(
      resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), {}),
    ).toBe('198.51.100.7');
  });

  it('ignores x-real-ip entirely', () => {
    expect(resolveClientIp(req({ 'x-real-ip': '6.6.6.6' }), {})).toBe('10.0.0.9');
  });

  it('ignores cf-connecting-ip unless explicitly trusted', () => {
    expect(resolveClientIp(req({ 'cf-connecting-ip': '6.6.6.6' }), {})).toBe('10.0.0.9');
    expect(
      resolveClientIp(req({ 'cf-connecting-ip': '6.6.6.6' }), { TRUST_CF_CONNECTING_IP: 'false' }),
    ).toBe('10.0.0.9');
  });

  it('rejects malformed header values and falls back to the socket address', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '<script>' }), {})).toBe('10.0.0.9');
    expect(
      resolveClientIp(req({ 'cf-connecting-ip': 'not an ip' }), { TRUST_CF_CONNECTING_IP: 'true' }),
    ).toBe('10.0.0.9');
  });

  it('uses the socket address when zero proxy hops are trusted', () => {
    expect(
      resolveClientIp(req({ 'x-forwarded-for': '198.51.100.7' }), { TRUSTED_PROXY_HOPS: '0' }),
    ).toBe('10.0.0.9');
  });

  it('falls back to one hop for invalid hop configuration', () => {
    expect(
      resolveClientIp(req({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }), { TRUSTED_PROXY_HOPS: '99' }),
    ).toBe('198.51.100.7');
  });

  // Valid behaviour
  it('honours cf-connecting-ip when explicitly trusted', () => {
    expect(
      resolveClientIp(req({ 'cf-connecting-ip': '203.0.113.5' }), { TRUST_CF_CONNECTING_IP: 'true' }),
    ).toBe('203.0.113.5');
  });

  it('supports multiple trusted hops and IPv6', () => {
    expect(
      resolveClientIp(req({ 'x-forwarded-for': '9.9.9.9, 2001:db8::1, 172.16.0.1' }), { TRUSTED_PROXY_HOPS: '2' }),
    ).toBe('2001:db8::1');
  });
});

describe('PLAN-0066 claimed IP is forensic only', () => {
  it('returns null for missing or malformed claims', () => {
    expect(resolveClaimedIp(req({}))).toBeNull();
    expect(resolveClaimedIp(req({ 'x-forwarded-for': '<x>' }))).toBeNull();
  });

  it('records the left-most claim while the trusted IP stays distinct', () => {
    const r = req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' });
    expect(resolveClaimedIp(r)).toBe('1.2.3.4');
    expect(resolveClientIp(r, {})).toBe('198.51.100.7');
  });
});