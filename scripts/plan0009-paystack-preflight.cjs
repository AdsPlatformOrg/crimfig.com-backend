/* global require, __dirname, console, process, fetch, AbortSignal */
// Read-only TEST-key acceptance check. Never prints keys, balances, payloads or headers.
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  try {
    const values = new Map();
    for (const line of fs.readFileSync(path.join(__dirname, '../local-docker'), 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!match) throw Error('Invalid private configuration format');
      if (values.has(match[1])) throw Error('Duplicate private configuration field');
      values.set(match[1], match[2].trim().replace(/^(["'])(.*)\1$/, '$2'));
    }
    const key = values.get('PAYSTACK_SECRET_KEY') || '';
    const publicKey = values.get('PAYSTACK_PUBLIC_KEY') || '';
    if (!/^sk_test_[A-Za-z0-9]+$/.test(key) || !/^pk_test_[A-Za-z0-9]+$/.test(publicKey)) {
      throw Error('Valid TEST-only key pair required; live/empty values refused');
    }
    const response = await fetch('https://api.paystack.co/balance', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + key },
    });
    const data = await response.json();
    if (!response.ok || data?.status !== true || !Array.isArray(data.data)) {
      throw Error('Paystack TEST authentication/read check was not confirmed (HTTP ' + response.status + ')');
    }
    console.log('PASS: Paystack TEST secret accepted by read-only balance API. No payment/transfer created.');
    console.log('Public key has TEST format; key-pair ownership and webhook delivery remain separate checks.');
  } catch (error) {
    // Network error details may include sensitive request context; print only controlled messages.
    const known = ['Invalid private configuration format', 'Duplicate private configuration field',
      'Valid TEST-only key pair required; live/empty values refused'];
    console.error(known.includes(error.message) || error.message.startsWith('Paystack TEST authentication/') ? error.message :
      'Paystack read-only preflight unavailable; no provider write attempted.');
    process.exitCode = 1;
  }
})();
