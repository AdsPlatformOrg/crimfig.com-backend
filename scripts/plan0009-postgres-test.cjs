/* global require, process, console, __dirname */
// Disposable Windows PostgreSQL fallback. Never reads application .env or existing DB data.
const { spawn, spawnSync } = require('node:child_process');
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
let redis;
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
  if (process.env.PLAN0009_REDIS_URL) throw new Error('Unset PLAN0009_REDIS_URL before using this isolated runner');
  if ((process.argv.includes('--provider-only') || process.argv.includes('--transfer-only')) && !process.argv.includes('--provider-env')) throw new Error('Provider-only acceptance requires an explicit --provider-env file');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  pg('initdb', ['-D', data, '-U', 'plan0009test', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale']);
  initialized = true;
  fs.unlinkSync(passwordFile);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), "\nlisten_addresses='127.0.0.1'\nport=25432\n");
  pg('pg_ctl', ['-D', data, '-l', path.join(temp, 'postgres.log'), '-w', 'start']);
  started = true;
  pg('createdb', ['-h', '127.0.0.1', '-p', '25432', '-U', 'plan0009test', 'plan0009_test']);
  console.log('Isolated PostgreSQL 17 SCRAM cluster ready on loopback 25432. Existing services untouched.');
  if (process.argv.includes('--oauth')) {
    const redisConfig = path.join(temp, 'redis.conf');
    fs.writeFileSync(redisConfig, `bind 127.0.0.1\nport 26379\nprotected-mode yes\nrequirepass ${password}\nsave ""\nappendonly no\ndir "${temp.replace(/\\/g, '/')}"\n`);
    redis = spawn('C:\\laragon\\bin\\redis\\redis-x64-5.0.14.1\\redis-server.exe', [redisConfig], { windowsHide: true, stdio: 'ignore' });
    const readyScript = `const net=require('node:net'),s=net.connect(26379,'127.0.0.1');let data='';
      s.on('error',()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1));
      s.on('connect',()=>s.write('AUTH '+process.env.PLAN0009_REDIS_PASSWORD+'\\r\\nPING\\r\\n'));
      s.on('data',chunk=>{data+=chunk;if(data.includes('+PONG'))process.exit(0);if(data.includes('-ERR')||data.includes('-WRONGPASS'))process.exit(1);});`;
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const check = spawnSync(process.execPath, ['-e', readyScript], { windowsHide: true, stdio: 'ignore', timeout: 2000,
        env: { ...process.env, PLAN0009_REDIS_PASSWORD: password } });
      if (check.status === 0) { ready = true; break; }
    }
    if (!ready) throw new Error('Owned isolated Redis did not authenticate on loopback 26379');
    console.log('Owned isolated password-protected Redis ready on loopback 26379.');
  }
  if (process.argv.includes('--reconcile-snapshot')) {
    const snapshot = path.resolve(process.argv[process.argv.indexOf('--reconcile-snapshot') + 1] || '');
    const ownedRecovery = path.resolve(root, '../.production-recovery');
    if (path.dirname(snapshot) !== ownedRecovery || !snapshot.endsWith('.dump')) throw new Error('Use an owned recovery snapshot only');
    pg('pg_restore', ['-h', '127.0.0.1', '-p', '25432', '-U', 'plan0009test', '-d', 'plan0009_test', '--no-owner', '--no-privileges', '--exit-on-error', snapshot]);
    const env = { ...process.env, DATABASE_URL: `postgresql://plan0009test:${password}@127.0.0.1:25432/plan0009_test`, DB_SSL: 'false' };
    const upgraded = spawnSync(process.execPath, ['scripts/release-migrate.cjs'], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    if (upgraded.status) throw new Error('Restored snapshot schema upgrade did not pass guarded migration checks');
    const audit = `const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path');
      const load=createRequire(path.resolve('database/package.json')),{Client}=load('pg');
      const client=new Client({connectionString:process.env.DATABASE_URL,options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=3000'});
      (async()=>{try{await client.connect();const results=await client.query(fs.readFileSync('../docs/architecture/PLAN-0009-financial-reconciliation.sql','utf8'));
        console.log(JSON.stringify({snapshotRestored:true,schemaUpgraded:true,readOnly:true,findings:results.filter(r=>r.command==='SELECT').map((r,i)=>({check:i+1,rows:r.rowCount}))}));
      }finally{await client.end();}})().catch(()=>{console.error('Read-only snapshot audit failed; no customer rows printed');process.exitCode=1;});`;
    const checked = spawnSync(process.execPath, ['-e', audit], { cwd: root, windowsHide: true, encoding: 'utf8', env });
    if (checked.status) throw new Error('Read-only restored snapshot reconciliation failed');
    console.log(checked.stdout.trim());
    exitCode = 0;
  } else if (process.argv.includes('--migrations')) {
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
    pg('createdb', ['-h', '127.0.0.1', '-p', '25432', '-U', 'plan0009test', 'plan0009_empty']);
    const emptyEnv = { ...env, DATABASE_URL: env.DATABASE_URL.replace('/plan0009_test', '/plan0009_empty') };
    for (const [name, args, environment, shouldPass] of [
      ['unflagged empty schema', [], emptyEnv, false],
      ['production initialization', ['--initialize-staging'], { ...emptyEnv, RAILWAY_ENVIRONMENT_NAME: 'production' }, false],
      ['explicit empty staging', ['--initialize-staging'], { ...emptyEnv, RAILWAY_ENVIRONMENT_NAME: 'staging' }, true],
      ['staging replay', ['--initialize-staging'], { ...emptyEnv, RAILWAY_ENVIRONMENT_NAME: 'staging' }, true],
    ]) {
      const checked = spawnSync(process.execPath, ['scripts/release-migrate.cjs', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', env: environment });
      if ((checked.status === 0) !== shouldPass) throw new Error(`Staging initialization safeguard failed: ${name}`);
    }
    console.log('Empty-schema refusal, production flag refusal, explicit staging initialization and replay PASS.');
    exitCode = 0;
  } else {
  const providerIndex = process.argv.indexOf('--provider-env');
  const providerEnv = providerIndex < 0 ? undefined : path.resolve(root, process.argv[providerIndex + 1] || 'api/billing-api/.env');
  if (providerEnv && !providerEnv.startsWith(root + path.sep)) throw new Error('Provider configuration must be inside this backend workspace');
  const result = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--config', 'auth/jest.config.js',
    '--runInBand', '--runTestsByPath', 'auth/test/security/funding-postgres.spec.ts',
    ...(process.argv.includes('--provider-only') ? ['--testNamePattern', 'real Paystack TEST'] : []),
    ...(process.argv.includes('--transfer-only') ? ['--testNamePattern', 'real Paystack TEST transfer'] : []),
    ...(process.argv.includes('--oauth') ? ['--testNamePattern', 'real Redis OAuth'] : [])], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, PLAN0009_PG_URL: `postgresql://plan0009test:${password}@127.0.0.1:25432/plan0009_test`,
      ...(providerEnv ? { PLAN0009_PROVIDER_ENV: providerEnv } : {}),
      ...(redis ? { PLAN0009_REDIS_URL: `redis://:${password}@127.0.0.1:26379` } : {}) },
  });
  exitCode = result.status ?? 1;
  }
} catch (error) { console.error(error.message); }
finally {
  if (redis) redis.kill();
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
