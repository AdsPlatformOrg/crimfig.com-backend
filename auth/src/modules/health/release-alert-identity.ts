import { createPublicKey } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import policy from '../../../../shared/src/config/release-alerts.json';

const issuer = 'https://token.actions.githubusercontent.com';
const audience = 'crimfig-release-alerts';
const jwt = new JwtService();
let cached: { expires: number; keys: any[] } | undefined;

export async function verifyReleaseAlertIdentity(token: string, runId: string) {
  if (!token || token.length > 20000 || !/^[0-9]{1,25}$/.test(runId)) throw new UnauthorizedException();
  const header = jwt.decode(token, { complete: true }) as any;
  if (header?.header?.alg !== 'RS256' || typeof header.header.kid !== 'string') throw new UnauthorizedException();
  if (!cached || cached.expires <= Date.now() || !cached.keys.some(key => key.kid === header.header.kid)) {
    const response = await fetch(issuer + '/.well-known/jwks', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new UnauthorizedException();
    const text = await response.text();
    if (text.length > 100000) throw new UnauthorizedException();
    const payload = JSON.parse(text);
    if (!Array.isArray(payload.keys) || payload.keys.length > 30) throw new UnauthorizedException();
    cached = { expires: Date.now() + 3600000, keys: payload.keys };
  }
  const key = cached.keys.find(key => key.kid === header.header.kid && key.kty === 'RSA');
  if (!key) throw new UnauthorizedException();
  let claims: any;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    claims = await jwt.verifyAsync(token, { publicKey: String(publicKey), algorithms: ['RS256'],
      issuer, audience, maxAge: '10m' });
  } catch { throw new UnauthorizedException(); }
  const productionWorkflow = policy.repository + '/.github/workflows/ci.yml@refs/heads/production';
  const workflows = [
    productionWorkflow,
    policy.repository + '/.github/workflows/ci.yml@refs/heads/dev',
    policy.repository + '/.github/workflows/release-monitor.yml@refs/heads/dev',
    policy.repository + '/.github/workflows/release-monitor.yml@refs/heads/main',
  ];
  if (claims.repository !== policy.repository || claims.run_id !== runId ||
      !workflows.includes(claims.workflow_ref) || !claims.workflow_ref.endsWith('@' + claims.ref) ||
      (claims.workflow_ref === productionWorkflow && claims.event_name !== 'push') ||
      claims.repository_owner !== policy.repository.split('/')[0] ||
      !Number.isInteger(claims.iat) || claims.iat > Math.floor(Date.now() / 1000) + 30) {
    throw new UnauthorizedException();
  }
  return claims;
}
