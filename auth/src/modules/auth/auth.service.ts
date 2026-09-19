import {
  Injectable, ConflictException, UnauthorizedException, BadRequestException, Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { TokensService } from '../tokens/tokens.service';
import { EmailService } from '../email/email.service';
import { config } from '../../config/config';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { CrimfigLogger } from '@crimfig/shared';
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsString() @IsNotEmpty()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Reset token received via email' })
  @IsString() @IsNotEmpty()
  token!: string;

  @ApiProperty({ example: 'NewSecurePassword123!' })
  @IsString() @IsNotEmpty()
  newPassword!: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AuthService {
  private readonly logger = new CrimfigLogger(AuthService.name, 'auth-api');

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly tokensService: TokensService,
    private readonly emailService: EmailService,
    private readonly jwtService: JwtService,
  ) {}

  // ── Signup ────────────────────────────────────────────────────────────────

  async signup(dto: SignupDto) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });
    if (existing) throw new ConflictException('An account with this email already exists');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    const [user] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email.toLowerCase(),
        phone: dto.phone,
        passwordHash,
        preferredLocale: dto.preferredLocale ?? config.DEFAULTS.LOCALE,
        status: 'PENDING_VERIFICATION',
      })
      .returning({ id: schema.users.id, email: schema.users.email });

    await this.db.insert(schema.individualProfiles).values({
      userId: user.id,
      timezone: config.DEFAULTS.TIMEZONE,
      country: config.DEFAULTS.COUNTRY,
    });

    // Send email verification (fire-and-forget — errors are logged internally)
    const verificationToken = this.issueEmailToken(
      user.id,
      user.email,
      'email_verify',
      config.SECURITY.EMAIL_VERIFICATION_EXPIRES_IN,
    );
    await this.emailService.sendVerificationEmail({ email: user.email }, verificationToken);

    this.logger.audit('AUTH_SIGNUP', { userId: user.id });
    return { message: 'Account created. Please check your email to verify your account.', userId: user.id };
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, deviceFingerprint?: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');

    if (user.status === 'SUSPENDED') throw new UnauthorizedException('Account suspended. Contact support.');
    if (user.status === 'DELETED') throw new UnauthorizedException('Invalid credentials');

    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date(), lastActivityAt: new Date() })
      .where(eq(schema.users.id, user.id));

    if (user.mfaEnabled) {
      const mfaChallengeToken = await this.tokensService.issueMfaChallengeToken(user.id);
      this.logger.audit('AUTH_LOGIN_MFA_REQUIRED', { userId: user.id });
      return { requiresMfa: true, mfaChallengeToken };
    }

    const tokens = await this.tokensService.issueTokenPair(
      user.id,
      (dto as any).clientId ?? 'crimfig_auth',
      deviceFingerprint,
    );
    this.logger.audit('AUTH_LOGIN_SUCCESS', { userId: user.id });
    return { requiresMfa: false, ...tokens };
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(userId: string, rawRefreshToken?: string) {
    if (rawRefreshToken) {
      await this.tokensService.revokeRefreshToken(rawRefreshToken);
    }
    this.logger.audit('AUTH_LOGOUT', { userId });
    return { message: 'Logged out successfully' };
  }

  // ── Refresh Token ─────────────────────────────────────────────────────────

  async refreshToken(rawRefreshToken: string, deviceFingerprint?: string) {
    const tokens = await this.tokensService.rotateRefreshToken(rawRefreshToken, deviceFingerprint);
    return tokens;
  }


  // ── Email Verification ────────────────────────────────────────────────────

  async verifyEmail(token: string) {
    const payload = this.verifyEmailToken(token, 'email_verify');

    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
    });
    if (!user) throw new BadRequestException('Invalid token');
    if (user.isEmailVerified) return { message: 'Email already verified' };

    await this.db
      .update(schema.users)
      .set({ isEmailVerified: true, status: 'ACTIVE' })
      .where(eq(schema.users.id, payload.sub));

    this.logger.audit('AUTH_EMAIL_VERIFIED', { userId: payload.sub });
    return { message: 'Email verified successfully. Your account is now active.' };
  }

  async resendVerification(userId: string, email: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });
    if (!user) throw new BadRequestException('User not found');
    if (user.isEmailVerified) throw new BadRequestException('Email is already verified');

    const token = this.issueEmailToken(
      userId,
      email,
      'email_verify',
      config.SECURITY.EMAIL_VERIFICATION_EXPIRES_IN,
    );
    await this.emailService.sendVerificationEmail({ email }, token);
    return { message: 'Verification email resent' };
  }

  // ── Password Reset ────────────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    // Always return success — never reveal if email exists
    if (!user) return { message: 'If an account with this email exists, a reset link has been sent.' };

    const token = this.issueEmailToken(
      user.id,
      user.email,
      'password_reset',
      config.SECURITY.PASSWORD_RESET_EXPIRES_IN,
    );
    await this.emailService.sendPasswordResetEmail({ email: user.email }, token);

    this.logger.audit('AUTH_PASSWORD_RESET_REQUESTED', { userId: user.id });
    return { message: 'If an account with this email exists, a reset link has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const payload = this.verifyEmailToken(dto.token, 'password_reset');

    const newHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
    await this.db
      .update(schema.users)
      .set({ passwordHash: newHash })
      .where(eq(schema.users.id, payload.sub));

    // Revoke all existing sessions after password reset
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.refreshTokens.userId, payload.sub));

    this.logger.audit('AUTH_PASSWORD_RESET_SUCCESS', { userId: payload.sub });
    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ── Internal: Email-purpose JWTs ─────────────────────────────────────────

  private issueEmailToken(
    userId: string,
    email: string,
    purpose: 'email_verify' | 'password_reset',
    expiresIn: string,
  ): string {
    return this.jwtService.sign(
      { sub: userId, email, purpose },
      { secret: config.JWT.ACCESS_SECRET, expiresIn },
    );
  }

  private verifyEmailToken(token: string, expectedPurpose: string): { sub: string; email: string } {
    try {
      const payload = this.jwtService.verify<{ sub: string; email: string; purpose: string }>(
        token,
        { secret: config.JWT.ACCESS_SECRET },
      );
      if (payload.purpose !== expectedPurpose) throw new Error('Wrong token purpose');
      return payload;
    } catch {
      throw new BadRequestException('Invalid or expired token. Please request a new one.');
    }
  }
}
