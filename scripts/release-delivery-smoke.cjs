const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

async function smoke({ base, origin, slot }) {
  if (!base || !origin || typeof slot !== 'string' || !/^cf-slot-[a-z0-9-]+$/.test(slot)) throw Error('Smoke fixture configuration required');
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid smoke base');
  const headers = { Origin: origin, Referer: origin + '/', 'User-Agent': 'CrimFig release delivery probe' };
  const ready = await fetch(new URL('/api/v1/health/ready', url), { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!ready.ok || (await ready.json()).status !== 'ready') throw Error('Service readiness failed');
  const request = new URL('/api/v1/delivery/ad/' + encodeURIComponent(slot), url);
  request.searchParams.set('domain', new URL(origin).hostname);
  request.searchParams.set('consent', 'unknown');
  const response = await fetch(request, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok || body.status !== 'success' || !body.data?.impToken ||
      !['image', 'text', 'video'].includes(body.data.adType)) throw Error('Delivery smoke failed');
  return { readiness: ready.status, delivery: response.status, adType: body.data.adType };
}
module.exports = { smoke };
if (require.main === module) {
  smoke({ base: process.env.RELEASE_ADS_BASE_URL, origin: process.env.RELEASE_PUBLISHER_ORIGIN,
    slot: process.env.RELEASE_ADS_SLOT }).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Release delivery smoke did not pass'); process.exitCode = 1; });
}
