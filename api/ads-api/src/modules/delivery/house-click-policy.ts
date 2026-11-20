import { BadRequestException } from '@nestjs/common';

export const HOUSE_CAMPAIGN_ID = '00000000-0000-4000-8000-00000000cf01';

export function defaultHouseDestination(): string {
  return process.env.APP_ENV === 'staging' || process.env.RAILWAY_ENVIRONMENT_NAME === 'staging' ||
    process.env.ADS_WEB_URL?.includes('staging')
    ? 'https://staging-ads.crimfig.com'
    : 'https://ads.crimfig.com';
}

export function parseHouseDestination(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length > 2048 ||
      !/^https?:\/\/[^/\\]/i.test(candidate) || /[\u0000-\u0020\u007f\\]/.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (!url.hostname || url.username || url.password || !['https:','http:'].includes(url.protocol) ||
        (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) return null;
    let pathname = url.pathname;
    for (let pass=0; pass<3; pass++) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    if (/\/api\/v1\/delivery(?:\/|$)/i.test(pathname)) return null;
    return url.href;
  } catch { return null; }
}

export function requireHouseDestination(candidate: unknown): string {
  const destination = parseHouseDestination(candidate);
  if (!destination) throw new BadRequestException('Choose an absolute, safe HTTP(S) destination URL.');
  return destination;
}

export function resolveSafeHouseDestinationUrl(candidate: unknown): string {
  return parseHouseDestination(candidate) ?? defaultHouseDestination();
}

/** An unverified marker can authorize only the fixed first-party fallback, with no data access. */
export function isHouseCampaignTokenPayload(token: unknown): boolean {
  if (typeof token !== 'string' || token.length > 2048) return false;
  const match = /^imp_([A-Za-z0-9_-]+)\./.exec(token);
  if (!match) return false;
  try {
    return JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'))?.campaignId === HOUSE_CAMPAIGN_ID;
  } catch { return false; }
}
