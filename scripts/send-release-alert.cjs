const policy = require('../shared/src/config/release-alerts.json');

async function sendAlert(kind = 'failure') {
  if (!policy.emailRecipients.length) return { accepted: false, disabled: true };
  const base = new URL(process.env.RELEASE_AUTH_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw Error('Invalid release alert transport');
  }
  const oidc = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidc.searchParams.set('audience', 'crimfig-release-alerts');
  const identity = await fetch(oidc, {
    headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const token = (await identity.json()).value;
  if (!identity.ok || typeof token !== 'string') throw Error('Release alert identity unavailable');
  const response = await fetch(new URL('/api/v1/health/release-alert', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ runId: process.env.GITHUB_RUN_ID, revision: process.env.GITHUB_SHA, kind }),
  });
  const result = await response.json();
  if (!response.ok || result.accepted !== true) throw Error('Release email was not accepted');
  return { accepted: true, providerMessageId: result.providerMessageId };
}
module.exports = { sendAlert };
if (require.main === module) {
  sendAlert(process.argv.includes('--test') ? 'test' : 'failure')
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Release email notification could not be confirmed'); process.exitCode = 1; });
}
