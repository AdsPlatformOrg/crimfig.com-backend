const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifySync, generateURI, generateSecret } = require('otplib');
// Public RFC 6238 SHA-1 test secret, never an enrolled account/device credential.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('installed MFA library rejects wrong and expired financial TOTP without a tolerance window', () => {
  assert.equal(verifySync({ secret, token: '000000', epoch: 59, epochTolerance: 0, period: 30, digits: 6 }).valid, false);
  assert.equal(verifySync({ secret, token: '287082', epoch: 90, epochTolerance: 0, period: 30, digits: 6 }).valid, false);
});
test('installed MFA library accepts the RFC 6238 vector in seconds and supports enrollment APIs', () => {
  assert.equal(verifySync({ secret, token: '287082', epoch: 59, epochTolerance: 0, period: 30, digits: 6 }).valid, true);
  assert.match(generateSecret(), /^[A-Z2-7]+$/);
  assert.match(generateURI({ secret, issuer: 'CrimFig', label: 'unit@example.invalid' }), /^otpauth:\/\/totp\//);
});
