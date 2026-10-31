import * as https from 'https';
import { deadline } from './website-proof';

export interface DnsProofResolution {
  isVerified: boolean;
  provider: 'cloudflare' | 'google' | 'none';
  status: 'confirmed' | 'proof_absent' | 'inconclusive' | 'unavailable' | 'invalid_response';
  errorMessage: string | null;
  ttl?: number;
}

interface DoHAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DoHResponse {
  Status: number;
  TC?: boolean;
  Question?: Array<{ name: string; type: number }>;
  Answer?: DoHAnswer[];
}

/**
 * Normalizes TXT data string according to RFC 1035:
 * Handles quoted strings and escaped characters.
 * Cloudflare returns: '"crimfig-site-verification=..."'
 * Google returns: 'crimfig-site-verification=...' or quoted string if whitespace/special chars.
 */
export function parseTxtRecordData(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // If wrapped in matching outer quotes, unquote and unescape
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const unquoted = trimmed.slice(1, -1);
    // Unescape \" and \\
    return unquoted.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/**
 * Fetches JSON response from a DoH endpoint with strict timeout and size cap (64 KiB).
 */
function fetchDoH(urlStr: string, acceptHeader: string): Promise<DoHResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const limit = 64 * 1024; // 64 KiB cap per PLAN-0054
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: acceptHeader,
          'User-Agent': 'CrimFig-Verification-Bot/1.0',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(new Error(`DoH returned HTTP ${res.statusCode}`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            res.destroy();
            return reject(new Error('DoH response exceeded 64KB limit'));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(body);
            resolve(json);
          } catch (err) {
            reject(new Error('Invalid DoH JSON response'));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Query a specific DoH provider for TXT records for a given hostname.
 */
async function queryProvider(
  provider: 'cloudflare' | 'google',
  hostname: string,
): Promise<{ ok: boolean; answers: DoHAnswer[]; status: number }> {
  let urlStr: string;
  let accept: string;

  if (provider === 'cloudflare') {
    urlStr = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=TXT`;
    accept = 'application/dns-json';
  } else {
    urlStr = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=TXT`;
    accept = 'application/json';
  }

  // 2-second timeout per provider query
  const res = await deadline(fetchDoH(urlStr, accept), 2000);

  // Status 0 is NOERROR (RFC 1035 / DNS RCODE)
  if (res.Status !== 0) {
    return { ok: false, answers: [], status: res.Status };
  }
  // Check for truncated response
  if (res.TC) {
    return { ok: false, answers: [], status: -1 }; // Truncated
  }

  return { ok: true, answers: Array.isArray(res.Answer) ? res.Answer : [], status: 0 };
}

/**
 * Reliable DNS TXT Ownership Verification with Public DoH Resolvers (PLAN-0054).
 * Primary: Cloudflare DNS (1.1.1.1)
 * Fallback: Google Public DNS (8.8.8.8)
 */
export async function resolveTxtDnsProof(
  hostname: string,
  expectedToken: string,
): Promise<DnsProofResolution> {
  const expectedRecord = `crimfig-site-verification=${expectedToken}`;

  let cfResult: { ok: boolean; answers: DoHAnswer[]; status: number } | null = null;
  let cfError: Error | null = null;

  // 1. Try Cloudflare primary
  try {
    cfResult = await queryProvider('cloudflare', hostname);
    if (cfResult.ok) {
      const match = cfResult.answers.find((a) => {
        // DNS type 16 is TXT
        if (a.type !== 16) return false;
        const parsed = parseTxtRecordData(a.data);
        return parsed === expectedRecord;
      });
      if (match) {
        return {
          isVerified: true,
          provider: 'cloudflare',
          status: 'confirmed',
          errorMessage: null,
          ttl: match.TTL,
        };
      }
    }
  } catch (err: any) {
    cfError = err;
  }

  // 2. Try Google fallback
  let gResult: { ok: boolean; answers: DoHAnswer[]; status: number } | null = null;
  let gError: Error | null = null;

  try {
    gResult = await queryProvider('google', hostname);
    if (gResult.ok) {
      const match = gResult.answers.find((a) => {
        if (a.type !== 16) return false;
        const parsed = parseTxtRecordData(a.data);
        return parsed === expectedRecord;
      });
      if (match) {
        return {
          isVerified: true,
          provider: 'google',
          status: 'confirmed',
          errorMessage: null,
          ttl: match.TTL,
        };
      }
    }
  } catch (err: any) {
    gError = err;
  }

  // If both providers returned valid responses but neither found the token
  if (cfResult?.ok && gResult?.ok) {
    return {
      isVerified: false,
      provider: 'none',
      status: 'proof_absent',
      errorMessage: 'Exact DNS TXT verification record was not found on public DNS resolvers.',
    };
  }

  // If one provider succeeded with empty answers and the other was unavailable/failed
  if (cfResult?.ok || gResult?.ok) {
    return {
      isVerified: false,
      provider: 'none',
      status: 'inconclusive',
      errorMessage: 'DNS verification inconclusive; record not yet observed on all public resolvers. Please retry in a few moments.',
    };
  }

  // If both providers threw errors / timed out
  return {
    isVerified: false,
    provider: 'none',
    status: 'unavailable',
    errorMessage: 'Public DNS resolvers were temporarily unavailable. Please retry in a moment.',
  };
}

