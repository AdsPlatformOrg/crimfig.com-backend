import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface ImpressionTokenPayload {
  servedId: string;
  placementId?: string;
  campaignId: string;
  creativeId: string;
  promoterId?: string;
  timestamp: number;
  ipHash: string;
}

@Injectable()
export class ImpressionTokenService {
  private readonly logger = new Logger(ImpressionTokenService.name);
  private readonly secretKey: string;
  private readonly ttlMs = 15 * 60 * 1000; // 15 minutes TTL

  constructor() {
    this.secretKey = process.env.ADS_IMPRESSION_SIGNING_KEY || 'crimfig_default_ads_sec_key_2026';
  }

  /**
   * Generates a signed, URL-safe impression token binding the serve context
   */
  generateToken(payload: Omit<ImpressionTokenPayload, 'timestamp'>): string {
    const fullPayload: ImpressionTokenPayload = {
      ...payload,
      timestamp: Date.now(),
    };

    const payloadJson = JSON.stringify(fullPayload);
    const encodedPayload = Buffer.from(payloadJson).toString('base64url');

    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(encodedPayload);
    const signature = hmac.digest('base64url');

    return `imp_${encodedPayload}.${signature}`;
  }

  /**
   * Verifies and decodes an impression token. Returns null if invalid or expired.
   */
  verifyToken(token: string, clientIp?: string): ImpressionTokenPayload | null {
    if (!token || !token.startsWith('imp_')) {
      return null;
    }

    const raw = token.slice(4); // Remove 'imp_' prefix
    const parts = raw.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, signature] = parts;

    // Verify HMAC signature
    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(encodedPayload);
    const expectedSignature = hmac.digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      this.logger.warn('Impression token signature mismatch');
      return null;
    }

    try {
      const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
      const payload: ImpressionTokenPayload = JSON.parse(payloadJson);

      // Check TTL expiry
      if (Date.now() - payload.timestamp > this.ttlMs) {
        this.logger.warn(`Impression token expired: age=${Date.now() - payload.timestamp}ms`);
        return null;
      }

      // If client IP is provided, verify matching IP hash
      if (clientIp) {
        const expectedIpHash = crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16);
        if (payload.ipHash && payload.ipHash !== expectedIpHash) {
          this.logger.warn('Impression token client IP hash mismatch');
          return null;
        }
      }

      return payload;
    } catch (err: any) {
      this.logger.error(`Failed to parse impression token: ${err.message}`);
      return null;
    }
  }

  /**
   * Computes truncated client IP hash for privacy-safe binding
   */
  hashIp(clientIp?: string): string {
    if (!clientIp) return 'unknown';
    return crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 16);
  }
}
