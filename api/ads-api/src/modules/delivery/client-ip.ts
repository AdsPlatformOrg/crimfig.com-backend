/**
 * PLAN-0066 F1: client IP resolution with an explicit trust boundary.
 *
 * Forwarding headers are client-controllable unless a trusted proxy overwrote
 * them, so:
 *  - `cf-connecting-ip` is honoured only when TRUST_CF_CONNECTING_IP=true
 *    (origin reachable only through Cloudflare).
 *  - `x-real-ip` is ignored.
 *  - `x-forwarded-for` is read from the RIGHT: the entry appended by the
 *    TRUSTED_PROXY_HOPS-th trusted proxy (default 1). Left-most entries are
 *    attacker-supplied and never used.
 *  - Otherwise the socket address is used.
 */
export interface IpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function plausibleIp(value: string): boolean {
  return value.length > 0 && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value);
}

export function resolveClientIp(
  req: IpRequestLike,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if ((env.TRUST_CF_CONNECTING_IP || 'false').toLowerCase() === 'true') {
    const cf = first(req.headers['cf-connecting-ip']);
    if (plausibleIp(cf)) return cf;
  }

  const hopsRaw = Number.parseInt(env.TRUSTED_PROXY_HOPS ?? '1', 10);
  const hops = Number.isInteger(hopsRaw) && hopsRaw >= 0 && hopsRaw <= 5 ? hopsRaw : 1;
  if (hops > 0) {
    const xff = first(req.headers['x-forwarded-for']);
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      const candidate = parts[parts.length - hops];
      if (candidate && plausibleIp(candidate)) return candidate;
    }
  }

  return req.socket?.remoteAddress || req.ip || '';
}

/**
 * The IP the client/forwarding chain *claims* (left-most forwarded entry, then
 * cf-connecting-ip, then x-real-ip). Stored for forensics only; NEVER used for
 * binding, rate limits, assessment or financial decisions - use resolveClientIp.
 */
export function resolveClaimedIp(req: IpRequestLike): string | null {
  const xff = first(req.headers['x-forwarded-for']).split(',')[0]?.trim() ?? '';
  for (const candidate of [xff, first(req.headers['cf-connecting-ip']), first(req.headers['x-real-ip'])]) {
    if (plausibleIp(candidate)) return candidate;
  }
  return null;
}
