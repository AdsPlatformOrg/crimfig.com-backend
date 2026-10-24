/* global require, process, setInterval, __dirname, URL */
// Test-only child: refuses every endpoint except the disposable PLAN-0009 database.
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.resolve(__dirname, '../api/billing-api/package.json'));
const { Pool } = load('pg');
const { drizzle } = load('drizzle-orm/node-postgres');
const schema = load('@crimfig/database/schema');
const { WalletService } = require('../api/billing-api/dist/api/billing-api/src/modules/wallet/wallet.service.js');
const url = new URL(process.env.PLAN0009_PG_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '25432' || url.pathname !== '/plan0009_test' || url.username !== 'plan0009test') {
  throw Error('Refusing non-disposable crash-test database');
}
const pool = new Pool({ connectionString: url.href, application_name: 'plan0009-funding-crash-child', max: 1 });
process.once('message', async ({ transactionId, proof }) => {
  try {
    await new WalletService(drizzle(pool, { schema }), {}, { paymentDomain: () => 'test' })
      .completeSuccessfulFunding(transactionId, proof);
    process.send({ committed: true });
    setInterval(() => {}, 1000); // Parent deliberately terminates the committed process.
  } catch {
    process.send({ failed: true });
    await pool.end();
    process.exit(1);
  }
});
