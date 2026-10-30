import { Injectable } from '@nestjs/common';
import { BrevoClient } from '@getbrevo/brevo';
import { config } from '../../config/config';
import { CrimfigLogger, escapeHtml, sanitizeMonitorString } from '@crimfig/shared';

export interface ErrorAlertEmailDeliveryResult {
  accepted: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface ErrorAlertCardTemplateInput {
  kind: 'initial' | 'window_summary';
  environment: string;
  service: string;
  httpMethod: string;
  normalizedRoute: string;
  statusCode: number;
  errorCategory: string;
  safeSummary: string;
  requestId: string;
  correlationId?: string | null;
  occurrenceCount: number;
  windowStartedAt: Date | string;
  windowEndsAt: Date | string;
  railwayLogUrl: string;
  monitorUrl: string;
}

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
        <div style="font-family:'Poppins',Arial,sans-serif;max-width:560px;margin:0 auto;color:#171B2A;padding:24px;">
          <h2 style="color:#171B2A;font-weight:700;">Verify your email</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>Click the button below to verify your email address. This link expires in <strong>5 minutes</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${verifyUrl}"
               style="background:#D4143A;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
              Verify Email
            </a>
          </p>
          <p style="color:#6B7280;font-size:13px;">Or copy this URL: <code>${verifyUrl}</code></p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="color:#9CA3AF;font-size:12px;">If you did not create a CrimFig account, you can safely ignore this email.</p>
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
        <div style="font-family:'Poppins',Arial,sans-serif;max-width:560px;margin:0 auto;color:#171B2A;padding:24px;">
          <h2 style="color:#171B2A;font-weight:700;">Reset your password</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>We received a request to reset the password for your CrimFig account. Click below — this link expires in <strong>15 minutes</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${resetUrl}"
               style="background:#D4143A;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color:#6B7280;font-size:13px;">Or copy this URL: <code>${resetUrl}</code></p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="color:#9CA3AF;font-size:12px;">If you did not request a password reset, your account is safe — no action is needed.</p>
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
        <div style="font-family:'Poppins',Arial,sans-serif;max-width:560px;margin:0 auto;color:#171B2A;padding:24px;">
          <h2 style="color:#171B2A;font-weight:700;">Organisation Invitation</h2>
          <p>Hi${params.to.name ? ` ${params.to.name}` : ''},</p>
          <p><strong>${params.inviterName}</strong> has invited you to join <strong>${params.orgName}</strong> on CrimFig as a <strong>${params.role}</strong>.</p>
          <p style="margin:32px 0;">
            <a href="${acceptUrl}"
               style="background:#D4143A;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">
              Accept Invitation
            </a>
          </p>
          <p style="color:#6B7280;font-size:13px;">Or copy this URL: <code>${acceptUrl}</code></p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="color:#9CA3AF;font-size:12px;">If you did not expect this invitation, you can safely ignore this email.</p>
        </div>
      `,
    });
  }

  /**
   * Send MFA backup codes to the user after TOTP enrollment.
   */
  async sendMfaBackupCodesEmail(to: { email: string; name?: string }, codes: string[]): Promise<void> {
    const codeList = codes.map((c) => `<li style="font-family:monospace;font-size:15px;padding:4px 0;">${c}</li>`).join('');
    await this.send({
      to,
      subject: 'Your CrimFig MFA backup codes',
      htmlContent: `
        <div style="font-family:'Poppins',Arial,sans-serif;max-width:560px;margin:0 auto;color:#171B2A;padding:24px;">
          <h2 style="color:#171B2A;font-weight:700;">Your MFA Backup Codes</h2>
          <p>Hi${to.name ? ` ${to.name}` : ''},</p>
          <p>You have successfully enabled two-factor authentication. Store these backup codes in a safe place — each code can only be used <strong>once</strong> if you lose access to your authenticator app.</p>
          <ul style="background:#F5F6F8;padding:20px 32px;border-radius:8px;list-style-type:none;margin:16px 0;">${codeList}</ul>
          <p style="color:#DC2626;font-weight:600;">⚠ Keep these codes private. Anyone with these codes can access your account.</p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="color:#9CA3AF;font-size:12px;">If you did not enable MFA on your account, contact support immediately.</p>
        </div>
      `,
    });
  }

  /**
   * Builds a sanitized, HTML-escaped CrimFig Error Alert card email subject, HTML body, and text body.
   * Never includes raw stack traces, request bodies, query values, headers, cookies, or secrets.
   */
  buildErrorAlertEmailContent(input: ErrorAlertCardTemplateInput): {
    subject: string;
    htmlContent: string;
    textContent: string;
  } {
    const envBadge = escapeHtml(input.environment.toUpperCase());
    const service = escapeHtml(input.service);
    const method = escapeHtml(input.httpMethod.toUpperCase());
    const route = escapeHtml(input.normalizedRoute);
    const status = Number(input.statusCode);
    const category = escapeHtml(input.errorCategory);
    const summary = escapeHtml(sanitizeMonitorString(input.safeSummary, 240));
    const requestId = escapeHtml(input.requestId);
    const correlationId = escapeHtml(input.correlationId || input.requestId);
    const count = Math.max(1, Number(input.occurrenceCount) || 1);
    const windowStartIso = new Date(input.windowStartedAt).toISOString();
    const windowEndIso = new Date(input.windowEndsAt).toISOString();
    const logUrl = escapeHtml(input.railwayLogUrl);
    const monitorUrl = escapeHtml(input.monitorUrl);

    const subjectPrefix =
      input.kind === 'window_summary'
        ? `[CrimFig ${input.environment.toUpperCase()} Summary • ${count}x]`
        : `[CrimFig ${input.environment.toUpperCase()} Alert]`;
    const subject = `${subjectPrefix} ${input.service} ${status} ${input.httpMethod.toUpperCase()} ${input.normalizedRoute} (${input.errorCategory})`.slice(
      0,
      240,
    );

    const htmlContent = `
      <div style="font-family:'Poppins',Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;color:#171B2A;">
        <div style="background:#171B2A;color:#FFFFFF;padding:20px 24px;border-bottom:3px solid #D4143A;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#F87171;margin-bottom:4px;">
            CrimFig Platform Error Monitor • ${envBadge}
          </div>
          <h2 style="margin:0;font-size:18px;font-weight:700;color:#FFFFFF;">
            ${input.kind === 'window_summary' ? `Suppressed Error Window Summary (${count} occurrences)` : `Service Error Detected: HTTP ${status}`}
          </h2>
        </div>
        <div style="padding:24px;">
          <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.5;">
            ${summary}
          </p>
          <table style="width:100%;border-collapse:collapse;background:#F5F6F8;border-radius:8px;padding:12px;font-size:13px;">
            <tbody>
              <tr>
                <td style="padding:8px 12px;font-weight:600;color:#4B5563;width:38%;">Service &amp; Environment</td>
                <td style="padding:8px 12px;color:#171B2A;font-family:monospace;">${service} (${envBadge})</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;font-weight:600;color:#4B5563;">Endpoint</td>
                <td style="padding:8px 12px;color:#171B2A;font-family:monospace;">${method} ${route}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;font-weight:600;color:#4B5563;">HTTP Status &amp; Category</td>
                <td style="padding:8px 12px;color:#D4143A;font-weight:700;font-family:monospace;">${status} • ${category}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;font-weight:600;color:#4B5563;">Request / Correlation ID</td>
                <td style="padding:8px 12px;color:#171B2A;font-family:monospace;">${requestId}${correlationId !== requestId ? ` (corr: ${correlationId})` : ''}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;font-weight:600;color:#4B5563;">Window Count</td>
                <td style="padding:8px 12px;color:#171B2A;">${count} occurrence${count === 1 ? '' : 's'} (${escapeHtml(windowStartIso)} → ${escapeHtml(windowEndIso)})</td>
              </tr>
            </tbody>
          </table>
          <div style="margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;">
            <a href="${monitorUrl}" style="background:#D4143A;color:#FFFFFF;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;display:inline-block;margin-right:10px;">
              Open Auth Error Monitor
            </a>
            <a href="${logUrl}" style="background:#171B2A;color:#FFFFFF;padding:12px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;display:inline-block;">
              Inspect Railway Logs
            </a>
          </div>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 12px 0;">
          <p style="margin:0;color:#6B7280;font-size:11px;line-height:1.4;">
            Payloads, headers, cookies, query values, and stack traces are redacted by policy. Duplicate alerts for this fingerprint are suppressed within the active window.
          </p>
        </div>
      </div>
    `.trim();

    const textContent = [
      `${subjectPrefix} ${input.service} (${input.environment})`,
      `Summary: ${sanitizeMonitorString(input.safeSummary, 240)}`,
      `Endpoint: ${input.httpMethod.toUpperCase()} ${input.normalizedRoute}`,
      `Status / Category: ${status} (${input.errorCategory})`,
      `Request ID: ${input.requestId}`,
      `Occurrences in window: ${count} (${windowStartIso} -> ${windowEndIso})`,
      `Error Monitor: ${input.monitorUrl}`,
      `Railway Logs: ${input.railwayLogUrl}`,
    ].join('\n');

    return { subject, htmlContent, textContent };
  }

  /**
   * Sends an error monitor alert email and returns an explicit provider acceptance result
   * rather than swallowing errors and returning void.
   * Never logs or re-triggers error monitor alerts on failure (preventing recursive alert loops).
   */
  async sendErrorAlertEmail(params: {
    recipients: readonly string[];
    subject: string;
    htmlContent: string;
    textContent?: string;
  }): Promise<ErrorAlertEmailDeliveryResult> {
    if (!params.recipients || params.recipients.length === 0) {
      return { accepted: false, error: 'NO_RECIPIENTS_CONFIGURED' };
    }
    if (!this.client) {
      return { accepted: false, error: 'BREVO_CLIENT_NOT_INITIALIZED' };
    }

    try {
      const response = await this.client.transactionalEmails.sendTransacEmail({
        sender: { name: config.EMAIL.FROM_NAME, email: config.EMAIL.FROM },
        to: params.recipients.map((email) => ({ email })),
        subject: params.subject,
        htmlContent: params.htmlContent,
        textContent: params.textContent ?? params.subject,
      });
      const messageId =
        response && typeof response === 'object' && 'messageId' in (response as any)
          ? String((response as any).messageId)
          : (response as any)?.body?.messageId
            ? String((response as any).body.messageId)
            : undefined;
      return {
        accepted: true,
        providerMessageId: messageId,
      };
    } catch (err: unknown) {
      const safeError = sanitizeMonitorString(
        err instanceof Error ? err.message : String(err ?? 'Brevo send failed'),
        180,
      );
      this.logger.warn('Error alert email delivery failed via Brevo', {
        reason: safeError,
      });
      return {
        accepted: false,
        error: safeError || 'BREVO_DELIVERY_FAILED',
      };
    }
  }
}

