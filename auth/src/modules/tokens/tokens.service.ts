import { Injectable, Inject, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, isNull, sql } from 'drizzle-orm';
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
      columns: { id: true, email: true, status: true },
    });
    if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
      throw new UnauthorizedException('Account is not available');
    }

    // Look up the app ID from clientId
    let app = await this.db.query.apps.findFirst({
      where: eq(schema.apps.clientId, appClientId),
      columns: { id: true },
    });

    if (!app) {
      // Auto-provision standard first-party app if not yet present in database
      const [inserted] = await this.db
        .insert(schema.apps)
        .values({
          clientId: appClientId,
          name: appClientId === 'crimfig_auth' ? 'CrimFig Central Identity' : appClientId,
          subdomain: appClientId === 'crimfig_auth' ? 'auth.crimfig.com' : `${appClientId.replace('crimfig_', '')}.crimfig.com`,
          description: 'First-party CrimFig ecosystem application',
          currentTermsVersion: '1.0.0',
          isFirstParty: true,
          isActive: true,
        })
        .onConflictDoNothing()
        .returning({ id: schema.apps.id });

      app = inserted || (await this.db.query.apps.findFirst({
        where: eq(schema.apps.clientId, appClientId),
        columns: { id: true },
      }));
    }

    if (!app) {
      throw new UnauthorizedException(`Application client '${appClientId}' not recognized.`);
    }

    return this.createPair(this.db, user, app.id, randomUUID(), deviceFingerprint);
  }

  private async createPair(
    writer: Pick<NodePgDatabase<typeof schema>, 'insert'>,
    user: { id: string; email: string },
    appId: string,
    familyId: string,
    deviceFingerprint?: string,
  ): Promise<TokenPair> {
    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email, type: 'access' } satisfies JwtPayload,
      { secret: config.JWT.ACCESS_SECRET, expiresIn: config.JWT.ACCESS_EXPIRES_IN },
    );
    const decoded = this.jwtService.decode(accessToken) as { exp?: number } | null;
    const expiresIn = decoded?.exp === undefined ? 0 : decoded.exp - Math.floor(Date.now() / 1000);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Access token expiry is invalid');
    const refreshToken = randomUUID() + '-' + randomUUID();
    await writer.insert(schema.refreshTokens).values({
      userId: user.id,
      appId,
      familyId,
      tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
      deviceFingerprint: deviceFingerprint ?? null,
      expiresAt: new Date(Date.now() + config.JWT.REFRESH_EXPIRES_DAYS * 86_400_000),
    });
    return { accessToken, refreshToken, expiresIn };
  }

  async rotateRefreshToken(rawToken: string, deviceFingerprint?: string): Promise<TokenPair> {
    if (typeof rawToken !== 'string' || !rawToken || rawToken.length > 1024) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const result = await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const candidate = await tx.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.tokenHash, tokenHash),
      });
      if (!candidate) return { error: 'Invalid refresh token' };
      // Serialize rotation AND logout for every generation of this family, across
      // processes/subdomains. READ COMMITTED re-read below sees the lock winner.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'crimfig-refresh:' + candidate.familyId}, 0))`);
      const stored = await tx.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.tokenHash, tokenHash),
      });
      if (!stored) return { error: 'Invalid refresh token' };
      const now = new Date();
      if (stored.revokedAt) {
        const successor = await tx.query.refreshTokens.findFirst({
          where: and(eq(schema.refreshTokens.familyId, stored.familyId), isNull(schema.refreshTokens.revokedAt)),
        });
        // A bounded collision window: no token is issued and no cookie is changed.
        // The caller must retry explicitly using the cookie from the winning response.
        const age = now.getTime() - stored.revokedAt.getTime();
        if (successor && successor.expiresAt > now && age >= 0 && age < 10_000) return { conflict: true };
        await tx.update(schema.refreshTokens).set({ revokedAt: now }).where(
          and(eq(schema.refreshTokens.familyId, stored.familyId), isNull(schema.refreshTokens.revokedAt)),
        );
        return { error: 'Refresh token reuse detected' };
      }
      const user = await tx.query.users.findFirst({
        where: eq(schema.users.id, stored.userId),
        columns: { id: true, email: true, status: true },
      });
      if (stored.expiresAt <= now || !user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
        await tx.update(schema.refreshTokens).set({ revokedAt: now }).where(
          and(eq(schema.refreshTokens.familyId, stored.familyId), isNull(schema.refreshTokens.revokedAt)),
        );
        return { error: 'Session expired or account unavailable' };
      }
      await tx.update(schema.refreshTokens).set({ revokedAt: now }).where(eq(schema.refreshTokens.id, stored.id));
      const tokens = await this.createPair(tx, user, stored.appId, stored.familyId,
        deviceFingerprint ?? stored.deviceFingerprint ?? undefined);
      return { tokens };
    }, { isolationLevel: 'read committed' });
    // Throw AFTER commit so replay/expiry revocation is not rolled back.
    if (result.conflict) throw new ConflictException({
      code: 'REFRESH_CONFLICT', message: 'Session refresh already completed in another request. Retry explicitly.',
    });
    if (!result.tokens) throw new UnauthorizedException(result.error);
    return result.tokens;
  }

  async revokeRefreshToken(rawToken: string, userId?: string): Promise<void> {
    if (!rawToken) return;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const stored = await tx.query.refreshTokens.findFirst({ where: eq(schema.refreshTokens.tokenHash, tokenHash) });
      if (!stored) return;
      if (userId && stored.userId !== userId) throw new UnauthorizedException('Session does not belong to this user');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'crimfig-refresh:' + stored.familyId}, 0))`);
      // Revoke descendants as well: logout must win against an in-flight rotation.
      await tx.update(schema.refreshTokens).set({ revokedAt: new Date() }).where(
        and(eq(schema.refreshTokens.familyId, stored.familyId), isNull(schema.refreshTokens.revokedAt)),
      );
    });
  }

  async issueMfaChallengeToken(userId: string): Promise<string> {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { id: true, email: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    return this.jwtService.sign(
      { sub: user.id, email: user.email, type: 'mfa_challenge' } as JwtPayload,
      { secret: config.JWT.ACCESS_SECRET, expiresIn: config.JWT.MFA_CHALLENGE_EXPIRES_IN },
    );
  }

  verifyAccessToken(token: string): JwtPayload {
    return this.jwtService.verify(token, { secret: config.JWT.ACCESS_SECRET });
  }
}

