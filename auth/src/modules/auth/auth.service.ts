import {
  Injectable, ConflictException, UnauthorizedException, Inject,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { TokensService } from '../tokens/tokens.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly tokensService: TokensService,
  ) {}

  async signup(dto: SignupDto) {
    // Check for existing user
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });
    if (existing) throw new ConflictException('An account with this email already exists');

    // Hash password with Argon2id
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // Create user
    const [user] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email.toLowerCase(),
        phone: dto.phone,
        passwordHash,
        preferredLocale: dto.preferredLocale ?? 'en',
        status: 'PENDING_VERIFICATION',
      })
      .returning({ id: schema.users.id, email: schema.users.email });

    // Create individual profile with Nigeria defaults
    await this.db.insert(schema.individualProfiles).values({
      userId: user.id,
      timezone: 'Africa/Lagos',
      country: 'NG',
    });

    // TODO: Send email verification — EmailModule (Phase 1b)

    return { message: 'Account created. Please check your email to verify your account.', userId: user.id };
  }

  async login(dto: LoginDto, deviceFingerprint?: string) {
    // Find user
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    // Generic error — do not reveal if email exists or not
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');

    // Check account status
    if (user.status === 'SUSPENDED') throw new UnauthorizedException('Account suspended. Contact support.');
    if (user.status === 'DELETED') throw new UnauthorizedException('Invalid credentials');

    // Update last login timestamp
    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date(), lastActivityAt: new Date() })
      .where(eq(schema.users.id, user.id));

    // Issue tokens — MFA check delegated to MFA module if mfa_enabled
    if (user.mfaEnabled) {
      // Return a short-lived pre-auth token signalling MFA challenge required
      const mfaChallengeToken = await this.tokensService.issueMfaChallengeToken(user.id);
      return { requiresMfa: true, mfaChallengeToken };
    }

    const tokens = await this.tokensService.issueTokenPair(user.id, 'crimfig_auth', deviceFingerprint);
    return { requiresMfa: false, ...tokens };
  }

  async logout(userId: string, tokenHash: string) {
    await this.tokensService.revokeRefreshToken(tokenHash);
    return { message: 'Logged out successfully' };
  }
}
