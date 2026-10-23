/* global require, console, __dirname */
// Resolve exactly as the deployed Node process does, without ts-jest aliases.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
require('reflect-metadata');
for (const app of ['auth', 'api/ads-api', 'api/billing-api']) {
  const load = createRequire(path.resolve(__dirname, '..', app, 'package.json'));
  const entry = load.resolve('@crimfig/database/schema');
  assert.match(entry.replaceAll('\\', '/'), /\/database\/dist\/schema\/index\.js$/);
  const schema = load('@crimfig/database/schema');
  for (const name of ['users', 'billingSavedCards', 'billingWallets', 'billingProviderEvents',
    'adsCampaigns', 'adsServes', 'adsSettlementClaims', 'adsSettlementCarries']) {
    assert.ok(schema[name]?.id, `${app}: missing current schema ${name}`);
  }
  console.log(`${app}: compiled schema exports resolve correctly`);
}
const { CardsService } = require('../api/billing-api/dist/api/billing-api/src/modules/cards/cards.service.js');
assert.equal(typeof CardsService, 'function');
console.log('Billing CardsService loads in compiled Node runtime');
