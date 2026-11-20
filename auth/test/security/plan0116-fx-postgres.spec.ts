import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

(process.env.PLAN0009_PG_URL ? test : test.skip)('PLAN0116 transaction rate migration preserves legacy rows and exact six-decimal snapshots', async () => {
  const url = new URL(process.env.PLAN0009_PG_URL!);
  if (url.hostname !== '127.0.0.1' || url.port !== '25432' ||
      url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') {
    throw new Error('Refusing non-disposable database');
  }
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('CREATE SCHEMA plan0116_fixture');
    await client.query('SET LOCAL search_path TO plan0116_fixture');
    await client.query('CREATE TABLE billing_transactions (id integer PRIMARY KEY, exchange_rate_numeric numeric(12,4))');
    await client.query('INSERT INTO billing_transactions VALUES (1, NULL), (2, 1550.1234)');
    await client.query(readFileSync(resolve(__dirname, '../../../database/migrations/0047_transaction_fx_precision.sql'), 'utf8'));
    await client.query('INSERT INTO billing_transactions VALUES (3, $1)', ['1550.123457']);
    const { rows } = await client.query('SELECT exchange_rate_numeric FROM billing_transactions ORDER BY id');
    expect(rows).toEqual([
      { exchange_rate_numeric: null },
      { exchange_rate_numeric: '1550.123400' },
      { exchange_rate_numeric: '1550.123457' },
    ]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}, 20000);
