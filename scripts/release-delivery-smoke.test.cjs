const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { smoke } = require('./release-delivery-smoke.cjs');
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
