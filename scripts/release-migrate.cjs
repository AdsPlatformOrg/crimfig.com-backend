/* global require, process, console, __dirname, URL */
// Explicit operator release command. Never called by application startup.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../database/package.json'));
const { Client } = load('pg');
const { drizzle } = load('drizzle-orm/node-postgres');
const { migrate } = load('drizzle-orm/node-postgres/migrator');
const { readMigrationFiles } = load('drizzle-orm/migrator');
const folder = process.env.RELEASE_MIGRATIONS_DIR || path.resolve(__dirname, '../database/migrations');
const migrations = readMigrationFiles({ migrationsFolder: folder });
const connectionString = process.env.DATABASE_URL;
const client = new Client({
  connectionString, connectionTimeoutMillis: 10000, statement_timeout: 60000, lock_timeout: 10000,
  application_name: 'crimfig-controlled-schema-release',
  ssl: process.env.DB_SSL === 'false' ? false : process.env.DB_SSL === 'true' ||
    (connectionString && new URL(connectionString).hostname.includes('railway') &&
      !new URL(connectionString).hostname.endsWith('.railway.internal')) ? { rejectUnauthorized: false } : false,
});
(async () => {
  if (!connectionString) throw new Error('Explicit DATABASE_URL required');
  if (!fs.existsSync(path.join(folder, 'meta/_journal.json'))) throw new Error('Migration journal required');
  await client.connect();
  const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', ['6746578390210']);
  if (!lock.rows[0].acquired) throw new Error('Another schema release holds the lock');
  const before = await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
  if (!before.rows.length || before.rows.length > migrations.length) throw new Error('Unexpected migration history');
  for (const [index, row] of before.rows.entries()) {
    if (row.hash !== migrations[index].hash || Number(row.created_at) !== migrations[index].folderMillis) {
      throw new Error(`Migration history mismatch at index ${index}; no pending migrations applied`);
    }
  }
  console.log(`[Schema release] Verified ${before.rows.length} existing migration hashes; ${migrations.length - before.rows.length} pending`);
  await migrate(drizzle(client), { migrationsFolder: folder });
  const after = await client.query('SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations');
  if (after.rows[0].count !== migrations.length) throw new Error('Migration ledger count does not match release');
  console.log(`[Schema release] ${migrations.length} registered migrations verified`);
})().catch(error => {
  console.error('[Schema release] Failed:', error.code || error.message);
  process.exitCode = 1;
}).finally(() => client.end());
