import { createHmac, timingSafeEqual } from 'node:crypto';

type ContinuityRequest = {
  origin?: string;
  consentState?: 'granted' | 'denied' | 'unknown';
  privacyControl?: boolean;
  continuityProof?: string;
};

/** Accept a short-lived assertion issued by an approved publisher's server. */
export function cpcVisitorContinuity(
  request: ContinuityRequest | undefined,
  publisherOrigin: string,
  campaignId: string,
  policy: { origin?: string; issuerSecret?: string; continuitySecret?: string },
  now = Date.now(),
): string | undefined {
  if (!policy.issuerSecret || policy.issuerSecret.length < 32 ||
      !policy.continuitySecret || policy.continuitySecret.length < 32 ||
      policy.issuerSecret === policy.continuitySecret ||
      policy.origin !== publisherOrigin || request?.origin !== publisherOrigin ||
      request.consentState !== 'granted' || request.privacyControl) return;
  const proof = request.continuityProof;
  if (!proof || !/^[a-f0-9]{32}\.[0-9]{13}\.[a-f0-9]{64}$/.test(proof)) return;
  const [subject, expiry, signature] = proof.split('.');
  if (Number(expiry) <= now || Number(expiry) > now + 300_000) return;
  const signed = JSON.stringify(['crimfig:cpc-continuity:v1', publisherOrigin, subject, expiry]);
  const expected = createHmac('sha256', policy.issuerSecret).update(signed).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return;
  return createHmac('sha256', policy.continuitySecret)
    .update(JSON.stringify(['crimfig:cpc-campaign:v1', publisherOrigin, campaignId, subject]))
    .digest('hex');
}
