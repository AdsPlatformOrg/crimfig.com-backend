function safeOrigin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error('Invalid smoke base');
  return url.origin;
}

const policy = require('../shared/src/config/release-alerts.json');

async function readiness(base, revision) {
  const response = await fetch(new URL('/api/v1/health/ready', safeOrigin(base)), {
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok || body.status !== 'ready' || (revision && body.revision !== revision)) {
    throw Error('Service readiness or release revision did not match');
  }
  return response.status;
}

async function reporting({ base, authBase, email, password }) {
  if (!email || !password) throw Error('Reporting fixture credentials required');
  const login = await fetch(new URL('/api/v1/auth/login', safeOrigin(authBase)), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await login.json();
  if (!login.ok || session.requiresMfa || typeof session.accessToken !== 'string' ||
      typeof session.refreshToken !== 'string') throw Error('Reporting fixture login failed');
  const headers = { Authorization: 'Bearer ' + session.accessToken };
  try {
    const response = await fetch(new URL('/api/v1/reports/daily?role=advertiser', safeOrigin(base)), {
      headers, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok || body.status !== 'success' || body.data?.role !== 'advertiser' ||
        !Array.isArray(body.data.daily) || !Array.isArray(body.data.breakdown) ||
        !body.data.totals || Object.values(body.data.totals).some(value => value !== '0')) {
      throw Error('Dedicated reporting fixture returned unexpected data');
    }
    return response.status;
  } finally {
    const response = await fetch(new URL('/api/v1/auth/logout', safeOrigin(authBase)), {
      method: 'POST', headers: { ...headers, Cookie: 'crimfig_rt=' + encodeURIComponent(session.refreshToken) },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error('Reporting fixture session cleanup failed');
  }
}

async function delivery({ base, origin, slot }) {
  if (!base || !origin || typeof slot !== 'string' || !/^cf-slot-[a-z0-9-]+$/.test(slot)) {
    throw Error('Smoke fixture configuration required');
  }
  const url = safeOrigin(base);
  const publisher = safeOrigin(origin);
  const request = new URL('/api/v1/delivery/ad/' + encodeURIComponent(slot), url);
  request.searchParams.set('domain', new URL(publisher).hostname);
  request.searchParams.set('consent', 'unknown');
  const response = await fetch(request, {
    headers: { Origin: publisher, Referer: publisher + '/', 'User-Agent': 'CrimFig release delivery probe' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.status !== 'success' || !body.data?.impToken ||
      !['image', 'text', 'video'].includes(body.data.adType)) throw Error('Delivery smoke failed');
  return { delivery: response.status, adType: body.data.adType };
}

async function smoke({ base, origin, slot, authBase, billingBase, email, password, revision }) {
  const url = safeOrigin(base);
  if (revision && !/^[0-9a-f]{40}$/.test(revision)) throw Error('Invalid expected release revision');
  const ready = await readiness(url, revision);
  const result = { readiness: ready, ...await delivery({ base, origin, slot }) };
  if (authBase || billingBase) {
    if (!authBase || !billingBase) throw Error('Both Auth and Billing smoke URLs required');
    result.auth = await readiness(authBase, revision);
    result.billing = await readiness(billingBase, revision);
    result.reporting = await reporting({ base: url, authBase, email, password });
  }
  return result;
}

async function waitForRelease(options, seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 900) throw Error('Bounded release wait required');
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      await readiness(options.base, options.revision);
      if (options.authBase) await readiness(options.authBase, options.revision);
      if (options.billingBase) await readiness(options.billingBase, options.revision);
      return;
    } catch {
      if (Date.now() >= deadline) throw Error('Candidate release did not become ready');
      await new Promise(resolve => setTimeout(resolve, Math.min(10000, Math.max(0, deadline - Date.now()))));
    }
  }
}

module.exports = { smoke, readiness, reporting, waitForRelease };
if (require.main === module) {
  const options = {
    base: process.env.RELEASE_ADS_BASE_URL, origin: process.env.RELEASE_PUBLISHER_ORIGIN,
    slot: process.env.RELEASE_ADS_SLOT, authBase: process.env.RELEASE_AUTH_BASE_URL,
    billingBase: process.env.RELEASE_BILLING_BASE_URL, email: process.env.RELEASE_REPORT_EMAIL,
    password: process.env.RELEASE_REPORT_PASSWORD, revision: process.env.RELEASE_EXPECTED_REVISION,
  };
  (async () => {
    if (process.argv.includes('--production-delivery')) {
      if (!/^[0-9a-f]{40}$/.test(options.revision ?? '')) throw Error('Expected production revision required');
      if (!options.slot || !/^cf-slot-[a-z0-9-]+$/.test(options.slot)) throw Error('Production fixture slot required');
      for (const value of [options.base, options.origin]) {
        if (!safeOrigin(value).startsWith('https://')) throw Error('Production fixture requires HTTPS');
      }
      await waitForRelease(options, Number(process.env.RELEASE_WAIT_SECONDS ?? '0'));
      const result = await delivery(options);
      if (result.adType !== 'image') throw Error('Expected production image ad');
      console.log(JSON.stringify({ revision: options.revision, ...result }));
      return;
    }
    if (process.argv.includes('--monitor')) {
      const response = await fetch(new URL('/api/v1/health/ready', safeOrigin(options.base)), {
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      options.revision = (await response.json()).revision;
      if (!response.ok) throw Error('Runtime readiness unavailable');
    }
    if (!options.revision || !options.authBase || !options.billingBase || !options.email || !options.password) {
      throw Error('Full release smoke configuration required');
    }
    await waitForRelease(options, Number(process.env.RELEASE_WAIT_SECONDS ?? '0'));
    const started = Date.now();
    const result = await smoke(options);
    const durationMs = Date.now() - started;
    if (durationMs > policy.maxResponseMs) throw Error('Release smoke latency limit exceeded');
    console.log(JSON.stringify({ revision: options.revision, durationMs, ...result }));
  })().catch(() => { console.error('Release or delivery check did not pass'); process.exitCode = 1; });
}
