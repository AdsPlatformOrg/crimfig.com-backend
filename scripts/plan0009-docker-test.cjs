/* global require, __dirname, process, setTimeout, console */
/** Disposable Docker-only PostgreSQL/Redis verification; never reads application .env files. */
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runId = randomBytes(8).toString('hex');
const label = 'com.crimfig.plan0009.run';
const names = [];
const env = { ...process.env,
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  PLAN0009_REDIS_PASSWORD: randomBytes(32).toString('hex'),
};
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    // Never dump environment, connection URLs or inspect output containing credentials.
    throw new Error(`Docker ${args[0]} failed; check engine availability, cached images and free test ports`);
  }
  return result.stdout.trim();
}
async function ready(name, args, expected) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const output = docker(['exec', name, ...args], true);
    if (output !== null && (expected === undefined || output === expected)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Disposable test service did not become ready');
}
(async () => {
  let exitCode = 1;
  try {
    if (process.env.PLAN0009_PG_URL) throw new Error('Unset PLAN0009_PG_URL: this runner creates its own disposable database');
    if (docker(['context', 'show']) !== 'desktop-linux' || process.env.DOCKER_HOST) throw new Error('Use local Docker Desktop desktop-linux context without DOCKER_HOST override');
    docker(['version', '--format', '{{.Server.Version}}']);
    // Resolve exact cached official repository/tag to immutable image ID. Some Desktop tag lookups
    // fail despite image ls containing the tag; ID inspection avoids repeated registry pulls.
    const images = docker(['image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']).split(/\r?\n/);
    const cached = tag => {
      const matches = images.filter(line => line.startsWith(tag + ' ')).map(line => line.slice(tag.length + 1).trim());
      if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0])) throw new Error('Required official cached Docker image missing');
      docker(['image', 'inspect', matches[0], '--format', '{{.Id}}']);
      return matches[0];
    };
    const pgImage = cached('postgres:16'), redisImage = cached('redis:7');
    const pg = `crimfig-plan0009-pg-${runId}`;
    docker(['run', '--detach', '--rm', '--pull=never', '--name', pg, '--label', `${label}=${runId}`,
      '--publish', '127.0.0.1:25432:5432', '--env', 'POSTGRES_PASSWORD',
      '--env', 'POSTGRES_USER=plan0009test', '--env', 'POSTGRES_DB=plan0009_test',
      pgImage]); names.push(pg);
    const redis = `crimfig-plan0009-redis-${runId}`;
    docker(['run', '--detach', '--rm', '--pull=never', '--name', redis, '--label', `${label}=${runId}`,
      '--publish', '127.0.0.1:26379:6379', '--env', 'PLAN0009_REDIS_PASSWORD', redisImage,
      'sh', '-c', 'exec redis-server --save "" --appendonly no --requirepass "$PLAN0009_REDIS_PASSWORD"']); names.push(redis);
    await ready(pg, ['pg_isready', '-U', 'plan0009test', '-d', 'plan0009_test']);
    await ready(redis, ['sh', '-c', 'REDISCLI_AUTH="$PLAN0009_REDIS_PASSWORD" redis-cli ping'], 'PONG');
    if (!docker(['exec', redis, 'redis-cli', 'ping']).startsWith('NOAUTH')) throw new Error('Redis authentication check failed');
    console.log('Disposable Docker PostgreSQL 16 and authenticated Redis 7 ready on loopback only.');
    const test = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', '--config', 'auth/jest.config.js',
      '--runInBand', '--runTestsByPath', 'auth/test/security/funding-postgres.spec.ts'], {
      cwd: root, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, PLAN0009_PG_URL: `postgresql://plan0009test:${env.POSTGRES_PASSWORD}@127.0.0.1:25432/plan0009_test` },
    });
    exitCode = test.status ?? 1;
  } catch (error) { console.error(error.message); }
  finally {
    for (const name of names.reverse()) {
      // Only containers created by this invocation with the exact random ownership label may be removed.
      if (docker(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name], true) !== runId) {
        console.error(`Cleanup ownership check failed for ${name}; inspect manually`); exitCode = 1; continue;
      }
      if (docker(['rm', '--force', '--volumes', name], true) === null) { console.error(`Cleanup failed for ${name}`); exitCode = 1; }
    }
    // Remove only test-owned containers and anonymous volumes. Existing services and images stay intact.
    process.exitCode = exitCode;
  }
})();
