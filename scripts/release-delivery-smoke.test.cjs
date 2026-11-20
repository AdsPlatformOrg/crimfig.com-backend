const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { smoke, readiness, reporting } = require('./release-delivery-smoke.cjs');
test('delivery failure blocks release even when readiness succeeds', async () => {
  let fail = true;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/health/ready')) return res.end(JSON.stringify({ status: 'ready' }));
    assert.match(req.url, /consent=unknown/);
    res.statusCode = fail ? 500 : 200;
    res.end(JSON.stringify(fail ? { status: 'error' } :
      { status: 'success', data: { adType: 'image', impToken: 'fixture' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const args = { base: 'http://127.0.0.1:' + server.address().port, origin: 'https://publisher.test', slot: 'cf-slot-fixture' };
    await assert.rejects(smoke(args), /Delivery smoke failed/);
    fail = false;
    assert.deepEqual(await smoke(args), { readiness: 200, delivery: 200, adType: 'image' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a different deployed revision cannot pass candidate acceptance', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ready', revision: 'a'.repeat(40) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await assert.rejects(readiness(base, 'b'.repeat(40)), /revision did not match/);
    assert.equal(await readiness(base, 'a'.repeat(40)), 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reporting rejects unexpected account data and revokes each fixture session', async () => {
  let unexpected = true;
  let logouts = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/auth/login')) {
      return res.end(JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', requiresMfa: false }));
    }
    assert.equal(req.headers.authorization, 'Bearer fixture-access');
    if (req.url.endsWith('/auth/logout')) {
      assert.equal(req.headers.cookie, 'crimfig_rt=fixture-refresh');
      logouts++;
      return res.end('{}');
    }
    res.end(JSON.stringify({ status: 'success', data: { role: 'advertiser', daily: [], breakdown: [],
      totals: { spend: unexpected ? '1' : '0' } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const options = { base, authBase: base, email: 'fixture@crimfig.invalid', password: 'test-only' };
    await assert.rejects(reporting(options), /unexpected data/);
    assert.equal(logouts, 1);
    unexpected = false;
    assert.equal(await reporting(options), 200);
    assert.equal(logouts, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
