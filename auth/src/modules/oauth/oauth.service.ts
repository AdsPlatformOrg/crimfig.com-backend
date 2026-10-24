import { Injectable, Inject, BadRequestException, UnauthorizedException, ServiceUnavailableException, OnModuleDestroy } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { createClient, type RedisClientType } from 'redis';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { config } from '../../config/config';
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class AuthorizeDto {
  @ApiProperty() @IsString() @IsNotEmpty() response_type!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) client_id!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2048) redirect_uri!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) scope?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) code_challenge?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() code_challenge_method?: string;
}

interface AuthCodePayload {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
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
    private readonly jwt: JwtService,
  ) {
    if (!Number.isInteger(this.AUTH_CODE_TTL_SECONDS) || this.AUTH_CODE_TTL_SECONDS < 1 || this.AUTH_CODE_TTL_SECONDS > 600) throw Error('OAuth code TTL must be between 1 and 600 seconds');
    this.redis = createClient({ url: config.REDIS.URL, disableOfflineQueue: true,
      socket: { connectTimeout: 3000, reconnectStrategy: retries => retries < 3 ? 100 : false } }) as RedisClientType;
    this.redis.on('error', () => { console.error('[OAuthService] State store unavailable'); });
    this.redis.connect().catch(() => { /* Readiness and request paths fail closed. */ });
  }

  async onModuleDestroy() {
    if (this.redis.isOpen) {
      if (this.redis.isReady) await this.redis.quit();
      else await this.redis.disconnect();
    }
  }

  async validateClient(clientId: string, redirectUri: string) {
    const client = await this.db.query.oauthClients.findFirst({
      where: and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.isActive, true)),
    });
    if (!client) throw new BadRequestException('Invalid client_id');

    let allowedUris: unknown;
    try { allowedUris = JSON.parse(client.redirectUris); } catch { throw new ServiceUnavailableException('Client registration is invalid'); }
    if (!Array.isArray(allowedUris) || allowedUris.some(uri => typeof uri !== 'string')) throw new ServiceUnavailableException('Client registration is invalid');
    if (!allowedUris.includes(redirectUri)) throw new BadRequestException('Invalid redirect_uri');
    let callback: URL;
    try { callback = new URL(redirectUri); } catch { throw new BadRequestException('Invalid redirect_uri'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname);
    if (callback.username || callback.password || callback.hash || (callback.protocol !== 'https:' &&
      !(config.IS_PRODUCTION === false && callback.protocol === 'http:' && local))) throw new BadRequestException('Invalid redirect_uri');
    return client;
  }

  async validateAuthorization(dto: AuthorizeDto) {
    const client = await this.validateClient(dto.client_id, dto.redirect_uri);
    if (dto.response_type !== 'code') throw new BadRequestException('Unsupported response_type');
    if (dto.code_challenge_method !== 'S256' || !/^[a-zA-Z0-9_-]{43}$/.test(dto.code_challenge || '')) throw new BadRequestException('S256 PKCE is required');
    const scopes = [...new Set((dto.scope || 'openid').split(' ').filter(Boolean))];
    const allowed = client.allowedScopes.split(' ').filter(Boolean);
    if (!scopes.length || scopes.some(scope => !['openid', 'profile', 'email'].includes(scope) || !allowed.includes(scope))) throw new BadRequestException('Invalid scope');
    return { client, scope: scopes.join(' ') };
  }

  async generateAuthCode(userId: string, dto: AuthorizeDto): Promise<string> {
    const { scope } = await this.validateAuthorization(dto);
    const user = await this.db.query.users.findFirst({ where: and(eq(schema.users.id, userId), eq(schema.users.status, 'ACTIVE')), columns: { id: true } });
    if (!user) throw new UnauthorizedException('Account is not available');
    if (!this.redis.isReady) {
      throw new ServiceUnavailableException('Authentication service state store is temporarily unavailable');
    }

    const code = randomUUID();
    const key = `${this.AUTH_CODE_KEY_PREFIX}${code}`;
    const payload: AuthCodePayload = { userId, clientId: dto.client_id, redirectUri: dto.redirect_uri, codeChallenge: dto.code_challenge!, scope };

    await this.redis.set(key, JSON.stringify(payload), { EX: this.AUTH_CODE_TTL_SECONDS });
    return code;
  }

  async exchangeCodeForTokens(code: string, clientId: string, redirectUri: string, codeVerifier?: string, clientSecret?: string) {
    if (!/^[a-f0-9-]{36}$/i.test(code) || !/^[a-zA-Z0-9._~-]{43,128}$/.test(codeVerifier || '')) throw new BadRequestException('Invalid authorization code or verifier');
    const client = await this.validateClient(clientId, redirectUri);
    if (client.clientSecretHash) {
      let authenticated = false;
      try { authenticated = typeof clientSecret === 'string' && await argon2.verify(client.clientSecretHash, clientSecret); } catch { /* Invalid stored hash also fails closed. */ }
      if (!authenticated) throw new UnauthorizedException('Client authentication required');
    } else if (clientSecret) throw new BadRequestException('Public clients must use PKCE without a client secret');
    if (!this.redis.isReady) {
      throw new ServiceUnavailableException('Authentication service state store is temporarily unavailable');
    }

    const key = `${this.AUTH_CODE_KEY_PREFIX}${code}`;
    const challenge = createHash('sha256').update(codeVerifier!).digest('base64url');
    // Match and consume in one Redis operation across replicas. Incorrect client,
    // callback or verifier cannot steal/consume another client's authorization.
    const codeData = await this.redis.eval(`
      local raw=redis.call('GET',KEYS[1]); if not raw then return false end
      local ok,payload=pcall(cjson.decode,raw); if not ok then return false end
      if payload.clientId~=ARGV[1] or payload.redirectUri~=ARGV[2] or payload.codeChallenge~=ARGV[3] then return false end
      redis.call('DEL',KEYS[1]); return raw`, { keys: [key], arguments: [clientId, redirectUri, challenge] });
    if (!codeData) throw new BadRequestException('Invalid or expired authorization code');
    const stored: AuthCodePayload = JSON.parse(String(codeData));

    if (!stored) throw new BadRequestException('Invalid or expired authorization code');

    if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
      throw new BadRequestException('Authorization code mismatch');
    }

    const scopes = stored.scope?.split(' ');
    if (!scopes?.length || scopes.some(scope => !client.allowedScopes.split(' ').includes(scope))) throw new BadRequestException('Granted scope is no longer available');
    const user = await this.db.query.users.findFirst({ where: and(eq(schema.users.id, stored.userId), eq(schema.users.status, 'ACTIVE')), columns: { id: true } });
    if (!user) throw new UnauthorizedException('Account is not available');
    const expiresIn = 300;
    const accessToken = this.jwt.sign({ sub: stored.userId, type: 'oauth_access', scope: stored.scope, jti: randomUUID() },
      { secret: config.JWT.ACCESS_SECRET, issuer: config.OAUTH.ISSUER, audience: clientId, algorithm: 'HS256', expiresIn });
    // OAuth grants cannot mint unrestricted dashboard tokens or refresh families.
    return { accessToken, expiresIn, token_type: 'Bearer', scope: stored.scope };
  }

  async getUserInfo(authorization: string | undefined) {
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization)) throw new UnauthorizedException('OAuth bearer token required');
    let payload: any;
    try { payload = this.jwt.verify(authorization.slice(7), { secret: config.JWT.ACCESS_SECRET, algorithms: ['HS256'], issuer: config.OAUTH.ISSUER }); }
    catch { throw new UnauthorizedException('Invalid OAuth token'); }
    if (payload.type !== 'oauth_access' || typeof payload.sub !== 'string' || typeof payload.aud !== 'string' || typeof payload.scope !== 'string') throw new UnauthorizedException('Invalid OAuth token');
    const client = await this.db.query.oauthClients.findFirst({ where: and(eq(schema.oauthClients.clientId, payload.aud), eq(schema.oauthClients.isActive, true)) });
    const scopes = payload.scope.split(' ');
    if (!client || scopes.some((scope: string) => !client.allowedScopes.split(' ').includes(scope))) throw new UnauthorizedException('OAuth grant is no longer available');
    const user = await this.db.query.users.findFirst({
      where: and(eq(schema.users.id, payload.sub), eq(schema.users.status, 'ACTIVE')),
      columns: { id: true, email: true, isEmailVerified: true, preferredLocale: true },
    });
    if (!user) throw new UnauthorizedException('Account is not available');
    return {
      sub: user.id,
      ...(scopes.includes('email') && { email: user.email, email_verified: user.isEmailVerified }),
      ...(scopes.includes('profile') && { locale: user.preferredLocale }),
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
