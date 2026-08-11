import { Injectable } from '@nestjs/common';
import { BrevoClient } from '@getbrevo/brevo';
import { config } from '../../config/config';
import { CrimfigLogger } from '@crimfig/shared';

// ─────────────────────────────────────────────────────────────────────────────
// EmailService — Brevo Transactional Email
//
// All outbound emails go through this service. Never send emails directly
// from controllers or other services — always inject and call EmailService.
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class EmailService {
  private readonly client: BrevoClient | null = null;
  private readonly logger = new CrimfigLogger(EmailService.name, 'auth-api');

  constructor() {
    try {
      if (config.EMAIL.BREVO_API_KEY) {
        this.client = new BrevoClient({ apiKey: config.EMAIL.BREVO_API_KEY });
      }
    } catch (err: any) {
      this.logger.warn('Failed to initialize Brevo client:', err.message);
      this.client = null;
    }
  }

  // ── Private helper ───────────────────────────────────────────────────────

  private async send(params: {
    to: { email: string; name?: string };
    subject: string;
    htmlContent: string;
    textContent?: string;
  }): Promise<void> {
    if (!this.client) {
      this.logger.warn('Brevo client not initialized. Skipping email send.', { to: params.to.email, subject: params.subject });
      return;
    }

    try {
      await this.client.transactionalEmails.sendTransacEmail({
        sender: { name: config.EMAIL.FROM_NAME, email: config.EMAIL.FROM },
        to: [{ email: params.to.email, name: params.to.name }],
        subject: params.subject,
        htmlContent: params.htmlContent,
        textContent: params.textContent ?? params.subject,
      });
      this.logger.log('Email sent successfully via Brevo', { to: params.to.email, subject: params.subject });
    } catch (err: unknown) {
      this.logger.error('Failed to send email via Brevo', String(err), { to: params.to.email, subject: params.subject });
    }
  }

  // ── Public Methods ───────────────────────────────────────────────────────

  /**
   * Send email address verification link.
   * The token is a short-lived signed JWT (5-minute expiry).
   */
  async sendVerificationEmail(to: { email: string; name?: string }, token: string): Promise<void> {
    const verifyUrl = `${config.APP.AUTH_WEB_URL}/verify-email?token=${token}`;
    await this.send({
      to,
      subject: 'Verify your CrimFig email address',
      htmlContent: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#1a1a2e;">Verify your email</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>Click the button below to verify your email address. This link expires in <strong>5 minutes</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${verifyUrl}"
               style="background:#6c63ff;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Verify Email
            </a>
          </p>
          <p style="color:#666;font-size:13px;">Or copy this URL: <code>${verifyUrl}</code></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:12px;">If you did not create a CrimFig account, you can safely ignore this email.</p>
        </div>
      `,
    });
  }

  /**
   * Send a password reset link.
   * The token is a signed JWT (15-minute expiry).
   */
  async sendPasswordResetEmail(to: { email: string; name?: string }, token: string): Promise<void> {
    const resetUrl = `${config.APP.AUTH_WEB_URL}/reset-password?token=${token}`;
    await this.send({
      to,
      subject: 'Reset your CrimFig password',
      htmlContent: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#1a1a2e;">Reset your password</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>We received a request to reset the password for your CrimFig account. Click below — this link expires in <strong>15 minutes</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${resetUrl}"
               style="background:#e63946;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Reset Password
            </a>
          </p>
          <p style="color:#666;font-size:13px;">Or copy this URL: <code>${resetUrl}</code></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:12px;">If you did not request a password reset, your account is safe — no action is needed.</p>
        </div>
      `,
    });
  }

  /**
   * Send an organisation invitation email.
   * @param inviteToken - Signed token encoding the invite (orgId + userId + role)
   */
  async sendOrgInviteEmail(params: {
    to: { email: string; name?: string };
    orgName: string;
    inviterName: string;
    role: string;
    inviteToken: string;
  }): Promise<void> {
    const acceptUrl = `${config.APP.AUTH_WEB_URL}/org/accept-invite?token=${params.inviteToken}`;
    await this.send({
      to: params.to,
      subject: `You've been invited to join ${params.orgName} on CrimFig`,
      htmlContent: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#1a1a2e;">Organisation Invitation</h2>
          <p>Hi${params.to.name ? ` ${params.to.name}` : ''},</p>
          <p><strong>${params.inviterName}</strong> has invited you to join <strong>${params.orgName}</strong> on CrimFig as a <strong>${params.role}</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${acceptUrl}"
               style="background:#06d6a0;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Accept Invitation
            </a>
          </p>
          <p style="color:#666;font-size:13px;">Or copy this URL: <code>${acceptUrl}</code></p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:12px;">If you did not expect this invitation, you can safely ignore this email.</p>
        </div>
      `,
    });
  }

  /**
   * Send MFA backup codes to the user after TOTP enrollment.
   */
  async sendMfaBackupCodesEmail(to: { email: string; name?: string }, codes: string[]): Promise<void> {
    const codeList = codes.map((c) => `<li style="font-family:monospace;font-size:15px;">${c}</li>`).join('');
    await this.send({
      to,
      subject: 'Your CrimFig MFA backup codes',
      htmlContent: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <h2 style="color:#1a1a2e;">Your MFA Backup Codes</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>You have successfully enabled two-factor authentication. Store these backup codes in a safe place — each code can only be used <strong>once</strong> if you lose access to your authenticator app.</p>
          <ul style="background:#f5f5f5;padding:20px 32px;border-radius:8px;">${codeList}</ul>
          <p style="color:#e63946;font-weight:600;">⚠ Keep these codes private. Anyone with these codes can access your account.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="color:#999;font-size:12px;">If you did not enable MFA on your account, contact support immediately.</p>
        </div>
      `,
    });
  }
}
