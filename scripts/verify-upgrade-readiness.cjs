const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../database/package.json'));
const { Client } = load('pg');
const { drizzle } = load('drizzle-orm/node-postgres');
const { requireServiceSchema } = load('@crimfig/database/schema');

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  const upgrade = url.pathname === '/release_upgrade_test' && url.username === 'release_test';
  const isolated = url.pathname === '/plan0009_test' && url.username === 'plan0009test' && url.port === '25432';
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !(upgrade || isolated)) {
    throw new Error('Disposable upgrade database required');
  }
  const client = new Client({ connectionString: url.href });
  try {
    await client.connect();
    const db = drizzle(client);
    for (const service of ['ads', 'billing', 'auth']) await requireServiceSchema(db, service);
    await client.query('begin');
    await client.query('alter table adstation_slots drop column manual_review_status');
    let rejected = false;
    try { await requireServiceSchema(db, 'ads'); } catch { rejected = true; }
    if (!rejected) throw new Error('Missing slot review column did not block readiness');
    await client.query('rollback');
    await requireServiceSchema(db, 'ads');
    console.log(JSON.stringify({ servicesReady: ['ads', 'billing', 'auth'], missingColumnRejected: true }));
  } finally { await client.query('rollback').catch(() => {}); await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
