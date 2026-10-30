// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — Central Error Alert & Monitor Configuration (PLAN-0045)
//
// Single authoritative configuration module for platform error alert recipients,
// capture toggles, email delivery toggles, and suppression window durations.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ERROR_ALERT_RECIPIENTS = ['jed@crimfig.com'] as const;

export const DEFAULT_SUPPRESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
export const REFUSED_INPUT_SUPPRESSION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_OCCURRENCE_SAMPLES_PER_GROUP = 25;

export type ErrorMonitorEnvironment = 'production' | 'staging' | 'development' | 'test';

export interface ErrorMonitorRuntimeConfig {
  environment: ErrorMonitorEnvironment;
  captureEnabled: boolean;
  emailEnabled: boolean;
  recipients: readonly string[];
  suppressionWindowMs: number;
  refusedInputWindowMs: number;
  maxSampledOccurrences: number;
  railwayProjectId?: string;
  railwayEnvironmentId?: string;
}

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Resolves the list of error alert email recipients.
 * - Uses `DEFAULT_ERROR_ALERT_RECIPIENTS` (`['jed@crimfig.com']`) when no override is provided.
 * - If `ERROR_ALERT_EMAILS` is provided, validates every comma-separated address and fails
 *   closed with a clear configuration error if the override is empty or contains invalid email syntax.
 */
export function resolveErrorAlertRecipients(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const rawOverride = env.ERROR_ALERT_EMAILS;
  if (rawOverride === undefined) {
    return Object.freeze([...DEFAULT_ERROR_ALERT_RECIPIENTS]);
  }

  const trimmed = rawOverride.trim();
  if (!trimmed) {
    throw new Error(
      '[error-alert.config] Invalid ERROR_ALERT_EMAILS override: value cannot be empty when set.',
    );
  }

  const candidates = trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (candidates.length === 0) {
    throw new Error(
      '[error-alert.config] Invalid ERROR_ALERT_EMAILS override: at least one valid email address is required.',
    );
  }

  for (const email of candidates) {
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      throw new Error(
        `[error-alert.config] Invalid email address in ERROR_ALERT_EMAILS override: "${email}".`,
      );
    }
  }

  return Object.freeze([...new Set(candidates)]);
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`[error-alert.config] Invalid boolean configuration value: "${value}".`);
}

export function resolveErrorMonitorEnvironment(
  env: Record<string, string | undefined> = process.env,
): ErrorMonitorEnvironment {
  const raw = (env.RAILWAY_ENVIRONMENT_NAME || env.APP_ENV || env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'staging' || raw === 'stage' || raw === 'dev') return 'staging';
  if (raw === 'test') return 'test';
  return 'development';
}

/**
 * Resolves the complete runtime configuration for the platform error monitor.
 * - Capture (`ERROR_MONITOR_CAPTURE_ENABLED`) defaults to `true` in production and `false` in staging/dev unless explicitly enabled.
 * - Email (`ERROR_MONITOR_EMAIL_ENABLED`) defaults to `false` in staging/dev/test and requires explicit `true` (or production default when configured) so staging tests never send unauthorized live emails.
 */
export function resolveErrorMonitorConfig(
  env: Record<string, string | undefined> = process.env,
): ErrorMonitorRuntimeConfig {
  const environment = resolveErrorMonitorEnvironment(env);
  const captureDefault = environment === 'production';
  const emailDefault = false; // Require explicit opt-in or production toggle to prevent accidental email floods

  const captureEnabled = parseBooleanFlag(env.ERROR_MONITOR_CAPTURE_ENABLED, captureDefault);
  const emailEnabled = parseBooleanFlag(env.ERROR_MONITOR_EMAIL_ENABLED, emailDefault);
  const recipients = resolveErrorAlertRecipients(env);

  return Object.freeze({
    environment,
    captureEnabled,
    emailEnabled,
    recipients,
    suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    refusedInputWindowMs: REFUSED_INPUT_SUPPRESSION_WINDOW_MS,
    maxSampledOccurrences: MAX_OCCURRENCE_SAMPLES_PER_GROUP,
    railwayProjectId: env.RAILWAY_PROJECT_ID?.trim() || undefined,
    railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID?.trim() || undefined,
  });
}
