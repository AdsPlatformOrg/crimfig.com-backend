/* global require, process, console, __dirname */
// Disposable Windows PostgreSQL fallback. Never reads application .env or existing DB data.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const binaries = 'C:\\Program Files\\PostgreSQL\\17\\bin';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crimfig-plan0009-pg-'));
const data = path.join(temp, 'data');
const passwordFile = path.join(temp, 'password');
const password = randomBytes(32).toString('hex');
let initialized = false, started = false, stopped = false, exitCode = 1;
function pg(binary, args) {
  const result = spawnSync(path.join(binaries, binary + '.exe'), args, {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    // PostgreSQL inherits Windows pipe handles; use its logfile, not captured parent pipes.
    stdio: binary === 'pg_ctl' ? 'ignore' : 'pipe',
    env: { ...process.env, PGPASSWORD: password },
  });
  if (result.error || result.status !== 0) {
    if (binary === 'pg_ctl' && fs.existsSync(path.join(temp, 'postgres.log'))) {
      console.error(fs.readFileSync(path.join(temp, 'postgres.log'), 'utf8').slice(-3000));
    }
    throw new Error(`${binary} failed (${result.error?.code || result.status}): ${(result.stderr || '').slice(-1500)}`);
  }
}
try {
  if (process.env.PLAN0009_PG_URL) throw new Error('Unset PLAN0009_PG_URL before using this isolated runner');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  pg('initdb', ['-D', data, '-U', 'plan0009test', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale']);
  initialized = true;
  fs.unlinkSync(passwordFile);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), "\nlisten_addresses='127.0.0.1'\nport=25432\n");
  pg('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-w', 'start']);
  started = true;
  pg('createdb', ['-h', '127.0.0.1', '-p', '25432', '-U', 'plan0009test', 'plan0009_test']);
  console.log('Isolated PostgreSQL 17 SCRAM cluster ready on loopback 25432. Existing services untouched.');
  if (process.argv.includes('--migrations')) {
    const env = { ...process.env, DATABASE_URL: `postgresql://plan0009test:${password}@127.0.0.1:25432/plan0009_test`, DB_SSL: 'false' };
    const baseline = path.join(temp, 'baseline');
    fs.mkdirSync(path.join(baseline, 'meta'), { recursive: true });
    const journal = JSON.parse(fs.readFileSync(path.join(root, 'database/migrations/meta/_journal.json'), 'utf8'));
    fs.writeFileSync(path.join(baseline, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    fs.copyFileSync(path.join(root, 'database/migrations', journal.entries[0].tag + '.sql'), path.join(baseline, journal.entries[0].tag + '.sql'));
    const bootstrap = `const {createRequire}=require('node:module'); const load=createRequire(require('node:path').resolve('database/package.json'));
      const {Client}=load('pg'),{drizzle}=load('drizzle-orm/node-postgres'),{migrate}=load('drizzle-orm/node-postgres/migrator');
      const c=new Client({connectionString:process.env.DATABASE_URL});
      (async()=>{try{await c.connect();await migrate(drizzle(c),{migrationsFolder:process.env.BASELINE_MIGRATIONS_DIR});}finally{await c.end();}})().catch(()=>{process.exitCode=1;});`;
    const first = spawnSync(process.execPath, ['-e', bootstrap], { cwd: root, windowsHide: true, encoding: 'utf8', env: { ...env, BASELINE_MIGRATIONS_DIR: baseline } });
    if (first.status) throw new Error('Initial-schema fixture failed');
    for (const args of [['scripts/release-migrate.cjs'], ['scripts/deployment-db-preflight.cjs'], ['scripts/release-migrate.cjs']]) {
      const run = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', env });
      if (run.status !== 0) throw new Error(`Migration verification failed: ${run.stderr}`);
      if (args[0].includes('preflight')) {
        const line = run.stdout.split('\n').find(value => value.includes('Missing current columns:'));
        if (!line || !line.endsWith('[]')) throw new Error('Registered migrations do not match application columns');
      }
    }
    const corrupt = `const {createRequire}=require('node:module');const load=createRequire(require('node:path').resolve('database/package.json'));
      const {Client}=load('pg'),c=new Client({connectionString:process.env.DATABASE_URL});
      (async()=>{try{await c.connect();await c.query("UPDATE drizzle.__drizzle_migrations SET hash='unknown-test-history' WHERE id=1");}finally{await c.end();}})().catch(()=>{process.exitCode=1;});`;
    const changed = spawnSync(process.execPath, ['-e', corrupt], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    if (changed.status) throw new Error('Unknown-history fixture failed');
    const rejected = spawnSync(process.execPath, ['scripts/release-migrate.cjs'], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    if (rejected.status === 0 || !rejected.stderr.includes('Migration history mismatch')) throw new Error('Unknown migration history was not rejected');
    console.log('Initial-schema upgrade, schema columns, idempotent replay and unknown-history rejection PASS.');
    exitCode = 0;
  } else {
  const result = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--config', 'auth/jest.config.js',
    '--runInBand', '--runTestsByPath', 'auth/test/security/funding-postgres.spec.ts'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, PLAN0009_PG_URL: `postgresql://plan0009test:${password}@127.0.0.1:25432/plan0009_test` },
  });
  exitCode = result.status ?? 1;
  }
} catch (error) { console.error(error.message); }
finally {
  if (initialized) {
    try { pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); stopped = true; }
    catch {
      // A failed start may have left no process; absence of PID is checked below.
      stopped = !started && !fs.existsSync(path.join(data, 'postmaster.pid'));
      if (!stopped) { console.error('Temporary cluster shutdown unconfirmed; preserving files at ' + temp); exitCode = 1; }
    }
  } else stopped = true;
  const resolved = path.resolve(temp);
  if (stopped && path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('crimfig-plan0009-pg-')) {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log('Owned temporary cluster files removed.');
  }
}
process.exitCode = exitCode;
