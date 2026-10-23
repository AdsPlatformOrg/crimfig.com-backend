/* global require, process, console, URL */
// Read-only schema/lock diagnostics; never applies a migration or reads customer rows.
const { Client } = require('pg');
const connectionString = process.env.DATABASE_URL;
const ssl = process.env.DB_SSL === 'false' ? false : process.env.DB_SSL === 'true' ||
  (connectionString && new URL(connectionString).hostname.includes('railway') &&
    !new URL(connectionString).hostname.endsWith('.railway.internal')) ? { rejectUnauthorized: false } : false;
const client = new Client({
  connectionString, ssl, connectionTimeoutMillis: 10000, statement_timeout: 8000,
  application_name: 'crimfig-release-readonly-preflight',
  ...(!connectionString ? { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD } : {}),
});
(async () => {
  console.log('[DB preflight] Connecting with a 10-second timeout');
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const ledger = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
  if (ledger.rows[0].present) {
    const migrations = await client.query('SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 6');
    console.log('[DB preflight] Migration ledger:', JSON.stringify(migrations.rows));
  } else console.log('[DB preflight] Migration ledger absent');
  const schema = await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name='ads_campaigns' AND column_name='pricing_version')
    OR table_name IN ('ads_settlement_claims','ads_settlement_carries')) ORDER BY table_name,ordinal_position`);
  console.log('[DB preflight] Release schema:', JSON.stringify(schema.rows));
  const locks = await client.query(`SELECT state,wait_event_type,wait_event,count(*)::integer AS connections
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
    GROUP BY state,wait_event_type,wait_event`);
  console.log('[DB preflight] Connection states:', JSON.stringify(locks.rows));
  await client.query('ROLLBACK');
  console.log('[DB preflight] Read-only checks completed');
})().catch(error => {
  console.error('[DB preflight] Failed:', error.code || error.name);
  process.exitCode = 1;
}).finally(() => client.end());
