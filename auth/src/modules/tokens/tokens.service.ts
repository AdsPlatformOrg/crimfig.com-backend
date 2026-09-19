import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { config } from '../../config/config';

export interface JwtPayload {
  sub: string;   // userId
  email: string;
  type: 'access' | 'refresh' | 'mfa_challenge';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

@Injectable()
export class TokensService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly jwtService: JwtService,
  ) {}

  async issueTokenPair(userId: string, appClientId: string, deviceFingerprint?: string): Promise<TokenPair> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { id: true, email: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const payload: JwtPayload = { sub: user.id, email: user.email, type: 'access' };

    const accessToken = this.jwtService.sign(payload, {
      secret: config.JWT.ACCESS_SECRET,
      expiresIn: config.JWT.ACCESS_EXPIRES_IN,
    });

    // Refresh token — opaque random string; we store only the SHA-256 hash
    const rawRefreshToken = randomUUID() + '-' + randomUUID();
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const familyId = randomUUID();

    // Look up the app ID from clientId
    const app = await this.db.query.apps.findFirst({
      where: eq(schema.apps.clientId, appClientId),
      columns: { id: true },
    });

    const expiresAt = new Date(Date.now() + config.JWT.REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);

    await this.db.insert(schema.refreshTokens).values({
      userId,
      appId: app!.id,
      tokenHash,
      familyId,
      deviceFingerprint: deviceFingerprint ?? null,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 15 * 60, // 15 minutes in seconds
    };
  }

  async rotateRefreshToken(rawToken: string, deviceFingerprint?: string): Promise<TokenPair> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const stored = await this.db.query.refreshTokens.findFirst({
      where: and(
        eq(schema.refreshTokens.tokenHash, tokenHash),
        isNull(schema.refreshTokens.revokedAt),
      ),
      with: { userId: true },
    });

    if (!stored) {
      // Token not found — may have been stolen + already used. Revoke entire family.
      const anyToken = await this.db.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.tokenHash, tokenHash),
      });
      if (anyToken) {
        await this.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, anyToken.familyId));
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (stored.expiresAt < new Date()) {
      await this.db.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(eq(schema.refreshTokens.tokenHash, tokenHash));
      throw new UnauthorizedException('Refresh token expired. Please log in again.');
    }

    // Revoke old token
    await this.db.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(eq(schema.refreshTokens.tokenHash, tokenHash));

    // Issue new pair in same family
    return this.issueTokenPair(stored.userId, 'crimfig_auth', deviceFingerprint);
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    if (!rawToken) return;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.db.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(eq(schema.refreshTokens.tokenHash, tokenHash));
  }

  async issueMfaChallengeToken(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { id: true, email: true },
    });
    return this.jwtService.sign(
      { sub: user!.id, email: user!.email, type: 'mfa_challenge' } as JwtPayload,
      { secret: config.JWT.ACCESS_SECRET, expiresIn: config.JWT.MFA_CHALLENGE_EXPIRES_IN },
    );
  }

  verifyAccessToken(token: string): JwtPayload {
    return this.jwtService.verify(token, { secret: config.JWT.ACCESS_SECRET });
  }
}

