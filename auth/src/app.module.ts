import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module';
import { OAuthModule } from './modules/oauth/oauth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { MfaModule } from './modules/mfa/mfa.module';
import { ConsentModule } from './modules/consent/consent.module';
import { TokensModule } from './modules/tokens/tokens.module';
import { DatabaseModule } from './modules/database/database.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // ─── Rate Limiting ────────────────────────────────────────────────────
    ThrottlerModule.forRoot([
      { name: 'short',  ttl: 1_000,  limit: 10  },   // 10 req/s burst
      { name: 'medium', ttl: 60_000, limit: 100 },   // 100 req/min
    ]),

    // ─── Core Modules ─────────────────────────────────────────────────────
    DatabaseModule,     // Drizzle ORM + PostgreSQL connection
    HealthModule,       // /api/health endpoint

    // ─── Feature Modules ─────────────────────────────────────────────────
    AuthModule,         // Signup, Login, Email verification
    OAuthModule,        // /oauth/authorize, /oauth/token, /oauth/userinfo
    TokensModule,       // JWT issuance, refresh, revocation
    MfaModule,          // TOTP, FIDO2/WebAuthn setup
    ConsentModule,      // App-specific Terms acceptance
    OrganizationsModule, // Multi-owner org management
  ],
})
export class AppModule {}
