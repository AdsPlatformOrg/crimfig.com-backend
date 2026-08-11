import {
  Injectable, Inject, BadRequestException, UnauthorizedException, ConflictException,
} from '@nestjs/common';
import { eq, and, isNull } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { config } from '../../config/config';
import { CrimfigLogger } from '@crimfig/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authenticator } = require('otplib');

// ─────────────────────────────────────────────────────────────────────────────
// MfaService — TOTP (RFC 6238) Two-Factor Authentication
//
// MFA secrets are encrypted with AES-256-GCM before storage in the database.
// Backup codes are single-use and stored encrypted (not hashed) so they
// can be individually revoked on first use.
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 8;

@Injectable()
export class MfaService {
  private readonly logger = new CrimfigLogger(MfaService.name, 'auth-api');
  private readonly encKey: Buffer;

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly emailService: EmailService,
  ) {
    this.encKey = Buffer.from(config.ENCRYPTION.KEY, 'hex');
    if (this.encKey.length !== 32) {
      throw new Error('[MfaService] ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars)');
    }
  }

  // ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────

  private encryptSecret(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decryptSecret(stored: string): string {
    const buf = Buffer.from(stored, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  // ── Backup codes ──────────────────────────────────────────────────────────

  private generateBackupCodes(): string[] {
    return Array.from({ length: BACKUP_CODE_COUNT }, () =>
      randomBytes(Math.ceil(BACKUP_CODE_LENGTH / 2))
        .toString('hex')
        .slice(0, BACKUP_CODE_LENGTH)
        .toUpperCase(),
    );
  }

  // ── TOTP Enrollment ───────────────────────────────────────────────────────

  async initiateTotpEnrollment(userId: string, userEmail: string): Promise<{
    secret: string;
    qrCodeDataUrl: string;
    otpauthUrl: string;
  }> {
    // Block if MFA already active
    const existingActive = await this.db.query.mfaDevices.findFirst({
      where: and(
        eq(schema.mfaDevices.userId, userId),
        eq(schema.mfaDevices.type, 'TOTP'),
        isNull(schema.mfaDevices.revokedAt),
        eq(schema.mfaDevices.isVerified, true),
      ),
    });
    if (existingActive) throw new ConflictException('TOTP is already enabled on this account');

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(userEmail, 'CrimFig', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Store encrypted secret — not yet verified
    await this.db.insert(schema.mfaDevices).values({
      userId,
      type: 'TOTP',
      secretOrPublicKey: this.encryptSecret(secret),
      nickname: 'Authenticator App',
      isVerified: false,
      isPrimary: false,
    });

    return { secret, qrCodeDataUrl, otpauthUrl };
  }

  async confirmTotpEnrollment(userId: string, userEmail: string, code: string): Promise<{ backupCodes: string[] }> {
    const device = await this.db.query.mfaDevices.findFirst({
      where: and(
        eq(schema.mfaDevices.userId, userId),
        eq(schema.mfaDevices.type, 'TOTP'),
        eq(schema.mfaDevices.isVerified, false),
        isNull(schema.mfaDevices.revokedAt),
      ),
    });
    if (!device) throw new BadRequestException('No pending TOTP enrollment found. Call /mfa/totp/enroll first.');

    const plainSecret = this.decryptSecret(device.secretOrPublicKey);
    const isValid = authenticator.check(code, plainSecret);
    if (!isValid) throw new BadRequestException('Invalid TOTP code. Please try again.');

    // Mark device as verified + primary
    await this.db.update(schema.mfaDevices)
      .set({ isVerified: true, isPrimary: true, lastUsedAt: new Date() })
      .where(eq(schema.mfaDevices.id, device.id));

    // Enable MFA on user record
    await this.db.update(schema.users)
      .set({ mfaEnabled: true })
      .where(eq(schema.users.id, userId));

    // Generate and store backup codes (encrypted, single-use)
    const plainCodes = this.generateBackupCodes();
    await Promise.all(
      plainCodes.map((code) =>
        this.db.insert(schema.mfaDevices).values({
          userId,
          type: 'BACKUP_CODE',
          secretOrPublicKey: this.encryptSecret(code),
          nickname: 'Backup Code',
          isVerified: true,
          isPrimary: false,
        }),
      ),
    );

    // Email backup codes to user
    await this.emailService.sendMfaBackupCodesEmail({ email: userEmail }, plainCodes);

    this.logger.audit('MFA_TOTP_ENROLLED', { userId });
    return { backupCodes: plainCodes };
  }

  // ── TOTP Verification (used during login challenge) ───────────────────────

  async verifyTotpCode(userId: string, code: string): Promise<boolean> {
    // Try TOTP device first
    const totpDevice = await this.db.query.mfaDevices.findFirst({
      where: and(
        eq(schema.mfaDevices.userId, userId),
        eq(schema.mfaDevices.type, 'TOTP'),
        eq(schema.mfaDevices.isVerified, true),
        isNull(schema.mfaDevices.revokedAt),
      ),
    });

    if (totpDevice) {
      const plainSecret = this.decryptSecret(totpDevice.secretOrPublicKey);
      if (authenticator.check(code, plainSecret)) {
        await this.db.update(schema.mfaDevices)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.mfaDevices.id, totpDevice.id));
        this.logger.audit('MFA_VERIFY_SUCCESS', { userId, method: 'TOTP' });
        return true;
      }
    }

    // Try backup codes (8-char hex)
    if (code.length === BACKUP_CODE_LENGTH) {
      const backupDevices = await this.db.query.mfaDevices.findMany({
        where: and(
          eq(schema.mfaDevices.userId, userId),
          eq(schema.mfaDevices.type, 'BACKUP_CODE'),
          eq(schema.mfaDevices.isVerified, true),
          isNull(schema.mfaDevices.revokedAt),
        ),
      });

      for (const bdevice of backupDevices) {
        const storedCode = this.decryptSecret(bdevice.secretOrPublicKey);
        if (storedCode.toUpperCase() === code.toUpperCase()) {
          // Single-use: revoke immediately
          await this.db.update(schema.mfaDevices)
            .set({ revokedAt: new Date() })
            .where(eq(schema.mfaDevices.id, bdevice.id));
          this.logger.audit('MFA_VERIFY_SUCCESS', { userId, method: 'BACKUP_CODE' });
          return true;
        }
      }
    }

    this.logger.warn('MFA_VERIFY_FAILED', { userId });
    return false;
  }

  // ── Disable MFA ───────────────────────────────────────────────────────────

  async disableMfa(userId: string, confirmCode: string): Promise<{ message: string }> {
    const isValid = await this.verifyTotpCode(userId, confirmCode);
    if (!isValid) throw new UnauthorizedException('Invalid MFA code');

    // Revoke all MFA devices
    await this.db.update(schema.mfaDevices)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.mfaDevices.userId, userId),
        isNull(schema.mfaDevices.revokedAt),
      ));

    await this.db.update(schema.users)
      .set({ mfaEnabled: false })
      .where(eq(schema.users.id, userId));

    this.logger.audit('MFA_DISABLED', { userId });
    return { message: 'Two-factor authentication has been disabled' };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getMfaStatus(userId: string) {
    const activeDevice = await this.db.query.mfaDevices.findFirst({
      where: and(
        eq(schema.mfaDevices.userId, userId),
        eq(schema.mfaDevices.type, 'TOTP'),
        eq(schema.mfaDevices.isVerified, true),
        isNull(schema.mfaDevices.revokedAt),
      ),
    });

    const backupDevices = await this.db.query.mfaDevices.findMany({
      where: and(
        eq(schema.mfaDevices.userId, userId),
        eq(schema.mfaDevices.type, 'BACKUP_CODE'),
        eq(schema.mfaDevices.isVerified, true),
        isNull(schema.mfaDevices.revokedAt),
      ),
    });

    return {
      mfaEnabled: !!activeDevice,
      totpConfigured: !!activeDevice,
      backupCodesRemaining: backupDevices.length,
    };
  }
}
