import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'crypto';
export interface PrivateRequest { version: 1; keyId: string; nonce: string; timestamp: number; path: string; body: string; signature: string }
export interface PrivateResponse { version: 1; keyId: string; nonce: string; timestamp: number; body: string; signature: string }
const message = (kind: string, keyId: string, nonce: string, timestamp: number, path: string, body: string) =>
  Buffer.from(JSON.stringify([kind, keyId, nonce, timestamp, path, createHash('sha256').update(body).digest('hex')]));
export function signPrivateRequest(path: string, value: unknown, keyId: string, privateKey: string, now = Date.now()): PrivateRequest {
  if (!/^\/internal\/v1\/[a-z/-]+$/.test(path)) throw new Error('Invalid private route');
  const key = createPrivateKey(privateKey); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid workload signing key');
  const request: PrivateRequest = { version: 1, keyId, nonce: randomUUID(), timestamp: now, path, body: JSON.stringify(value), signature: '' };
  request.signature = sign(null, message('financial-request-v1', keyId, request.nonce, now, path, request.body), key).toString('base64url');
  return request;
}
export function verifyPrivateRequest(r: PrivateRequest, keys: Readonly<Record<string, string>>, now = Date.now()): boolean {
  try {
    if (r.version !== 1 || !Number.isSafeInteger(r.timestamp) || Math.abs(now - r.timestamp) > 30_000 || typeof r.body !== 'string'
      || Buffer.byteLength(r.body) > 65536 || !/^\/internal\/v1\/[a-z/-]+$/.test(r.path)
      || !/^[a-f0-9-]{36}$/i.test(r.nonce) || !Object.prototype.hasOwnProperty.call(keys, r.keyId)
      || !/^[A-Za-z0-9_-]{86}$/.test(r.signature)) return false;
    const key = createPublicKey(keys[r.keyId]);
    return key.asymmetricKeyType === 'ed25519' && verify(null, message('financial-request-v1', r.keyId, r.nonce, r.timestamp, r.path, r.body), key, Buffer.from(r.signature, 'base64url'));
  } catch { return false; }
}
export function signPrivateResponse(request: PrivateRequest, value: unknown, keyId: string, privateKey: string, now = Date.now()): PrivateResponse {
  const key = createPrivateKey(privateKey); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid authority key');
  const response: PrivateResponse = { version: 1, keyId, nonce: request.nonce, timestamp: now, body: JSON.stringify(value), signature: '' };
  response.signature = sign(null, message('financial-response-v1', keyId, response.nonce, now, request.path, response.body), key).toString('base64url'); return response;
}
export function readPrivateResponse(r: PrivateResponse, request: PrivateRequest, keys: Readonly<Record<string, string>>, now = Date.now()): unknown {
  if (!r || r.version !== 1 || r.nonce !== request.nonce || !Number.isSafeInteger(r.timestamp) || Math.abs(now - r.timestamp) > 30000
    || typeof r.body !== 'string' || Buffer.byteLength(r.body) > 65536 || !Object.prototype.hasOwnProperty.call(keys, r.keyId)
    || !/^[A-Za-z0-9_-]{86}$/.test(r.signature)) throw new Error('Invalid authority response');
  const key = createPublicKey(keys[r.keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, message('financial-response-v1', r.keyId, r.nonce, r.timestamp, request.path, r.body), key, Buffer.from(r.signature, 'base64url'))) throw new Error('Untrusted authority response');
  return JSON.parse(r.body);
}
