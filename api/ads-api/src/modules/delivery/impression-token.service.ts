import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';

export interface ImpressionTokenPayload {
  version: 2;
  servedId: string;
  placementId: string;
  campaignId: string;
  creativeId: string;
  promoterId: string;
  timestamp: number;
  ipHash: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
@Injectable()
export class ImpressionTokenService {
  private readonly secretKey = process.env.ADS_IMPRESSION_SIGNING_KEY;
  private readonly ttlMs = 15 * 60 * 1000;

  private configured(): boolean {
    return typeof this.secretKey === 'string' && Buffer.byteLength(this.secretKey) >= 32 &&
      this.secretKey !== 'crimfig_default_ads_sec_key_2026';
  }

  assertConfigured(): void {
    if (!this.configured()) throw new ServiceUnavailableException('Ad delivery signing is not configured');
  }

  generateToken(payload: Omit<ImpressionTokenPayload, 'timestamp' | 'version'>): string {
    this.assertConfigured();
    const fullPayload = { ...payload, version: 2 as const, timestamp: Date.now() };
    if (!this.validPayload(fullPayload)) throw new ServiceUnavailableException('Ad serve identity is invalid');
    const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    return `imp_${encoded}.${crypto.createHmac('sha256', this.secretKey!).update(encoded).digest('base64url')}`;
  }

  private validPayload(payload: any): payload is ImpressionTokenPayload {
    return payload && payload.version === 2 &&
      ['servedId', 'placementId', 'campaignId', 'creativeId', 'promoterId']
        .every(key => typeof payload[key] === 'string' && uuid.test(payload[key])) &&
      Number.isSafeInteger(payload.timestamp) && payload.timestamp <= Date.now() &&
      Date.now() - payload.timestamp <= this.ttlMs &&
      typeof payload.ipHash === 'string' && /^(?:[a-f0-9]{16}|unknown)$/.test(payload.ipHash);
  }

  verifyToken(token: string, clientIp?: string): ImpressionTokenPayload | null {
    if (!this.configured() || typeof token !== 'string' || token.length > 2048) return null;
    const match = /^imp_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const [, encoded, signature] = match;
    const expected = crypto.createHmac('sha256', this.secretKey!).update(encoded).digest('base64url');
    // Equal-length canonical ASCII prevents timingSafeEqual throwing on attacker input.
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (!this.validPayload(payload) || payload.ipHash !== this.hashIp(clientIp)) return null;
      return payload;
    } catch { return null; }
  }

  hashIp(clientIp?: string): string {
    return clientIp ? crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16) : 'unknown';
  }
}
