/* global require, __dirname, console, process, fetch, AbortSignal */
// Read-only TEST-key acceptance check. Never prints keys, balances, payloads or headers.
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  try {
    const { createRequire } = require('node:module');
    const load = createRequire(path.join(__dirname, '../api/billing-api/package.json'));
    const file = process.argv[2] || path.join(__dirname, '../api/billing-api/.env');
    const values = new Map(Object.entries(load('dotenv').parse(fs.readFileSync(file))));
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
