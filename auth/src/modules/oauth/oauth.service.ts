import { Injectable, Inject, BadRequestException, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { createClient, type RedisClientType } from 'redis';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { TokensService } from '../tokens/tokens.service';
import { config } from '../../config/config';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class AuthorizeDto {
  @ApiProperty() @IsString() @IsNotEmpty() response_type: string;
  @ApiProperty() @IsString() @IsNotEmpty() client_id: string;
  @ApiProperty() @IsString() @IsNotEmpty() redirect_uri: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scope?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() code_challenge?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() code_challenge_method?: string;
}

interface AuthCodePayload {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class OAuthService implements OnModuleDestroy {
  /**
   * Auth codes are stored in Redis — NOT in-memory.
   *
   * HA REASONING: The auth service runs as multiple replicas behind a load
   * balancer. If auth codes were stored in-memory, a code generated on
   * instance A would fail when the /token exchange request hits instance B.
   * Redis is a shared, external store visible to ALL replicas simultaneously.
   * TTL of 300s (5 minutes) is enforced by Redis itself — no cron needed.
   */
  private redis: RedisClientType;
  private readonly AUTH_CODE_TTL_SECONDS = config.OAUTH.AUTH_CODE_EXPIRES_SECONDS;
  private readonly AUTH_CODE_KEY_PREFIX = 'oauth:code:';

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly tokensService: TokensService,
  ) {
    this.redis = createClient({ url: config.REDIS.URL }) as RedisClientType;
    this.redis.connect().catch((err) => {
      console.error('[OAuthService] Redis connection failed:', err);
      process.exit(1); // Hard fail — Redis is required for HA auth code storage
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async validateClient(clientId: string, redirectUri: string) {
    const client = await this.db.query.oauthClients.findFirst({
      where: and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.isActive, true)),
    });
    if (!client) throw new BadRequestException('Invalid client_id');

    const allowedUris: string[] = JSON.parse(client.redirectUris);
    if (!allowedUris.includes(redirectUri)) throw new BadRequestException('Invalid redirect_uri');
    return client;
  }

  async generateAuthCode(userId: string, clientId: string, redirectUri: string, codeChallenge?: string): Promise<string> {
    const { randomUUID } = await import('crypto');
    const code = randomUUID();

    const payload: AuthCodePayload = { userId, clientId, redirectUri, codeChallenge };
    const key = this.AUTH_CODE_KEY_PREFIX + code;

    // Stored in Redis with automatic TTL expiry — safe across all replicas
    await this.redis.set(key, JSON.stringify(payload), { EX: this.AUTH_CODE_TTL_SECONDS });
    return code;
  }

  async exchangeCodeForTokens(code: string, clientId: string, redirectUri: string, codeVerifier?: string) {
    const key = this.AUTH_CODE_KEY_PREFIX + code;

    // Atomic GET + DEL via pipeline — makes auth codes strictly single-use
    // even under concurrent requests hitting different instances
    const [rawPayload] = await this.redis.multi()
      .get(key)
      .del(key)
      .exec() as [string | null, number];

    if (!rawPayload) throw new BadRequestException('Invalid or expired authorization code');

    const stored: AuthCodePayload = JSON.parse(rawPayload);
    if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
      throw new BadRequestException('Authorization code mismatch');
    }

    // PKCE S256 verification
    if (stored.codeChallenge) {
      if (!codeVerifier) throw new BadRequestException('code_verifier required');
      const { createHash } = await import('crypto');
      const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
      if (challenge !== stored.codeChallenge) throw new BadRequestException('PKCE verification failed');
    }

    return this.tokensService.issueTokenPair(stored.userId, clientId);
  }

  async getUserInfo(userId: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      columns: { id: true, email: true, isEmailVerified: true, preferredLocale: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      sub: user.id,
      email: user.email,
      email_verified: user.isEmailVerified,
      locale: user.preferredLocale,
    };
  }

  async pingRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
