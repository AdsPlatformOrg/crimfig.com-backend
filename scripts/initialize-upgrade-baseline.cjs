const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../database/package.json'));
const { Client } = load('pg');
const { drizzle } = load('drizzle-orm/node-postgres');
const { migrate } = load('drizzle-orm/node-postgres/migrator');

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/release_upgrade_test' ||
      url.username !== 'release_test' || process.env.RELEASE_MIGRATIONS_DIR !== '/tmp/previous-release/database/migrations') {
    throw new Error('Dedicated disposable release-upgrade database required');
  }
  const client = new Client({ connectionString: url.href, statement_timeout: 60000 });
  try {
    await client.connect();
    const { rows } = await client.query("select count(*)::int as count from information_schema.tables where table_schema in ('public','drizzle')");
    if (rows[0].count !== 0) throw new Error('Previous-release initialization requires an empty database');
    await migrate(drizzle(client), { migrationsFolder: process.env.RELEASE_MIGRATIONS_DIR });
    console.log(JSON.stringify({ previousReleaseInitialized: true }));
  } finally { await client.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
