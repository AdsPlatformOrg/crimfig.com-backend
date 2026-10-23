import * as dns from 'dns/promises';
import * as https from 'https';
import { BlockList, isIP } from 'net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');

// Conservative first release: IPv6-only hosts fail closed pending a reviewed IPv6 policy.
export function publicIpv4(address: string): boolean {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

export function websiteTarget(domain: string, registeredUrl: string): URL {
  const host = domain.toLowerCase();
  if (host.length > 253 || !host.includes('.') || isIP(host) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('A public DNS domain is required');
  }
  const url = new URL(registeredUrl);
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password ||
      url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Verification requires the registered HTTPS domain root on port 443');
  }
  return url;
}

export async function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Verification timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function hasVerificationMeta(html: string, token: string): boolean {
  // Ignore non-rendered comments and raw-text elements; accept only an exact quoted meta pair.
  const markup = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|textarea|title|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  return (markup.match(/<[a-zA-Z!/?](?:[^>"']|"[^"]*"|'[^']*')*>/g) || []).some(tag => {
    if (!/^<meta\s/i.test(tag)) return false;
    const attributes = new Map<string, string>();
    const source = tag.slice(5, -1).replace(/\/\s*$/, '');
    const pattern = /\s*([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let position = 0;
    while (position < source.length && source.slice(position).trim()) {
      pattern.lastIndex = position;
      const match = pattern.exec(source);
      if (!match) return false;
      const name = match[1].toLowerCase();
      if (attributes.has(name)) return false;
      attributes.set(name, match[2] ?? match[3]);
      position = pattern.lastIndex;
    }
    return attributes.get('name') === 'crimfig-site-verification' && attributes.get('content') === token;
  });
}

export async function fetchWebsiteProof(url: URL): Promise<string> {
  const addresses = await deadline(dns.lookup(url.hostname, { all: true, verbatim: true }), 2000);
  if (!addresses.length || addresses.some(record => !publicIpv4(record.address))) {
    throw new Error('Domain must resolve exclusively to supported public IPv4 addresses');
  }
  const address = addresses[0].address;
  return new Promise((resolve, reject) => {
    const limit = 512 * 1024;
    const request = https.request(url, {
      method: 'GET', agent: false,
      // Preserve URL hostname/SNI/certificate validation while preventing a second DNS lookup.
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { 'User-Agent': 'Crimfig-Verification-Bot/1.0', Accept: 'text/html', 'Accept-Encoding': 'identity' },
    }, response => {
      const fail = (message: string) => { response.destroy(); request.destroy(new Error(message)); };
      if (response.statusCode !== 200) return fail('Verification requires HTTP 200; redirects are not followed');
      if (!/^text\/html(?:;|$)/i.test(response.headers['content-type'] || '') ||
          (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        return fail('Verification requires uncompressed HTML');
      }
      if (Number(response.headers['content-length']) > limit) return fail('Verification page exceeds size limit');
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) return fail('Verification page exceeds size limit');
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Verification response interrupted')));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    const timer = setTimeout(() => request.destroy(new Error('Verification request timed out')), 5000);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    request.end();
  });
}
