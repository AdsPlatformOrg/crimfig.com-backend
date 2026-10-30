import { createHash, randomUUID } from 'crypto';
import { SetMetadata } from '@nestjs/common';
import {
  DEFAULT_SUPPRESSION_WINDOW_MS,
  REFUSED_INPUT_SUPPRESSION_WINDOW_MS,
  type ErrorMonitorEnvironment,
} from './error-alert.config';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Explicit Financial / Payment / Escrow / Settlement / Webhook Tagging
// ─────────────────────────────────────────────────────────────────────────────

export const FINANCIAL_OPERATION_KEY = 'crimfig:financial_operation';

export type FinancialOperationCategory =
  | 'payment'
  | 'checkout'
  | 'wallet'
  | 'escrow'
  | 'settlement'
  | 'withdrawal'
  | 'webhook';

export interface FinancialOperationMetadata {
  isFinancial: true;
  category: FinancialOperationCategory;
}

/**
 * Route or Controller decorator marking an endpoint as a financial operation.
 * Eligibility for 4xx email alerts uses this explicit metadata rather than fragile URL substring matching.
 */
export const FinancialOperation = (category: FinancialOperationCategory = 'payment') =>
  SetMetadata(FINANCIAL_OPERATION_KEY, {
    isFinancial: true,
    category,
  } satisfies FinancialOperationMetadata);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Capture vs. Email Eligibility Matrix
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorSourceType = 'server' | 'browser';
export type EmailEligibility = 'eligible' | 'excluded_by_policy';
export type EmailExclusionReason =
  | 'HTTP_STATUS_EXCLUDED'
  | 'NON_FINANCIAL_4XX'
  | 'UNTRUSTED_BROWSER_SOURCE'
  | 'NON_ERROR_STATUS';

export type NotificationDeliveryState =
  | 'excluded_by_policy'
  | 'disabled'
  | 'pending'
  | 'provider_accepted'
  | 'suppressed_duplicate'
  | 'failed';

export interface EmailEligibilityDecision {
  captureInMonitor: boolean;
  emailEligibility: EmailEligibility;
  exclusionReason: EmailExclusionReason | null;
  statusLabel: string;
  suppressionWindowMs: number;
}

const ALWAYS_EXCLUDED_EMAIL_STATUSES = new Set<number>([403, 404, 429]);
const REFUSED_INPUT_4XX_STATUSES = new Set<number>([400, 401, 402, 409, 413, 422]);

/**
 * Evaluates whether an HTTP status + route classification should be captured in the
 * central Error Monitor and whether it qualifies for email alerting.
 *
 * Rules (PLAN-0045):
 * - All final HTTP 4xx and 5xx responses are captured in the Error Monitor.
 * - HTTP 404, 403, and 429 NEVER trigger email alerts, even on financial routes.
 * - HTTP 5xx on server routes are eligible for email alerts.
 * - Other HTTP 4xx (e.g. 400, 401, 402, 409, 422) are eligible ONLY on explicitly tagged financial routes.
 * - Browser-originated reports are captured in the monitor when valid, but never directly trigger email alerts without a corroborated server 5xx/financial failure.
 */
export function classifyErrorEmailEligibility(input: {
  statusCode: number;
  isFinancialRoute: boolean;
  source?: ErrorSourceType;
  errorCategory?: string;
}): EmailEligibilityDecision {
  const { statusCode, isFinancialRoute, source = 'server', errorCategory = '' } = input;

  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return {
      captureInMonitor: false,
      emailEligibility: 'excluded_by_policy',
      exclusionReason: 'NON_ERROR_STATUS',
      statusLabel: 'Not an error status',
      suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    };
  }

  // Rule 1: 404, 403, and 429 are ALWAYS monitor-only and excluded from email (even on financial routes).
  if (ALWAYS_EXCLUDED_EMAIL_STATUSES.has(statusCode)) {
    return {
      captureInMonitor: true,
      emailEligibility: 'excluded_by_policy',
      exclusionReason: 'HTTP_STATUS_EXCLUDED',
      statusLabel: 'Monitor only — email excluded by policy',
      suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    };
  }

  // Rule 2: Browser reports are monitor-only to prevent unauthenticated client traffic from triggering alert emails.
  if (source === 'browser') {
    return {
      captureInMonitor: true,
      emailEligibility: 'excluded_by_policy',
      exclusionReason: 'UNTRUSTED_BROWSER_SOURCE',
      statusLabel: 'Monitor only — email excluded by policy',
      suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    };
  }

  // Rule 3: Server 5xx responses are email-eligible (30m suppression window).
  if (statusCode >= 500) {
    return {
      captureInMonitor: true,
      emailEligibility: 'eligible',
      exclusionReason: null,
      statusLabel: 'Eligible for email alert',
      suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
    };
  }

  // Rule 4: Other 4xx on tagged financial routes are email-eligible.
  // Refused-input 4xx categories use the 24h suppression window when configured; conflicts/payment failures use 30m.
  if (isFinancialRoute) {
    const isRefusedInput =
      (statusCode === 400 || statusCode === 422) &&
      /VALIDATION|BAD_REQUEST|REFUSED_INPUT/i.test(errorCategory);
    return {
      captureInMonitor: true,
      emailEligibility: 'eligible',
      exclusionReason: null,
      statusLabel: 'Eligible for email alert',
      suppressionWindowMs: isRefusedInput
        ? REFUSED_INPUT_SUPPRESSION_WINDOW_MS
        : DEFAULT_SUPPRESSION_WINDOW_MS,
    };
  }

  // Rule 5: Non-financial 4xx are monitor-only.
  void REFUSED_INPUT_4XX_STATUSES;
  return {
    captureInMonitor: true,
    emailEligibility: 'excluded_by_policy',
    exclusionReason: 'NON_FINANCIAL_4XX',
    statusLabel: 'Monitor only — email excluded by policy',
    suppressionWindowMs: DEFAULT_SUPPRESSION_WINDOW_MS,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Route Normalization, Redaction, Fingerprinting & HTML Escaping
// ─────────────────────────────────────────────────────────────────────────────

const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_RE = /^\d{2,}$/;
const OPAQUE_TOKEN_SEGMENT_RE = /^[A-Za-z0-9_-]{20,}$/;

/**
 * Strips query strings/fragments and normalizes dynamic UUIDs, numeric IDs, and long tokens
 * into stable route placeholders (`:id`) so fingerprints never split on per-request IDs.
 */
export function normalizeErrorRoute(rawRoute: string | undefined | null): string {
  if (!rawRoute || typeof rawRoute !== 'string') return '/<unresolved>';
  const withoutQuery = rawRoute.split('?')[0].split('#')[0].trim();
  if (!withoutQuery.startsWith('/')) return '/<unresolved>';

  const segments = withoutQuery
    .split('/')
    .filter((seg, idx) => idx === 0 || seg.length > 0)
    .map((segment, index) => {
      if (index === 0) return '';
      if (segment.startsWith(':')) return segment.slice(0, 48);
      if (segment.startsWith('{') && segment.endsWith('}')) {
        return `:${segment.slice(1, -1).slice(0, 40)}`;
      }
      if (UUID_SEGMENT_RE.test(segment)) return ':id';
      if (NUMERIC_ID_RE.test(segment)) return ':id';
      if (OPAQUE_TOKEN_SEGMENT_RE.test(segment)) return ':ref';
      return segment.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64) || 'segment';
    });

  const normalized = segments.join('/') || '/';
  return normalized.slice(0, 240);
}

const FORBIDDEN_KEY_PATTERN =
  /password|passcode|secret|token|authorization|cookie|set-cookie|api[-_]?key|private[-_]?key|signature|card|cvv|cvc|pan|pin|iban|account[-_]?number|connection[-_]?string|database[-_]?url|raw[-_]?body|body|query|headers|stack|trace|email|phone/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bxkeysib-[A-Za-z0-9-]{16,}\b/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\d[ -]*?){13,19}\b/g,
];

/**
 * Scrubs any embedded tokens, JWTs, connection strings, emails, or card numbers from a string
 * and bounds its length.
 */
export function sanitizeMonitorString(value: unknown, maxLength = 240): string {
  if (typeof value !== 'string') return '';
  let cleaned = value.replace(/[\r\n\t]+/g, ' ').trim();
  for (const pattern of SECRET_VALUE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[REDACTED]');
  }
  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.slice(0, maxLength - 1)}…`;
  }
  return cleaned;
}

/**
 * Recursively strips forbidden keys (bodies, query values, cookies, headers, tokens, secrets,
 * raw stacks, emails, card numbers) from a metadata object and bounds string lengths.
 */
export function sanitizeMonitorContext(
  input: Record<string, unknown> | undefined | null,
  depth = 0,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 2) {
    return {};
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(input).slice(0, 20);

  for (const [key, rawVal] of entries) {
    const safeKey = key.slice(0, 64);
    if (FORBIDDEN_KEY_PATTERN.test(safeKey)) {
      continue;
    }
    if (rawVal === null || rawVal === undefined) continue;
    if (typeof rawVal === 'boolean' || (typeof rawVal === 'number' && Number.isFinite(rawVal))) {
      output[safeKey] = rawVal;
    } else if (typeof rawVal === 'string') {
      output[safeKey] = sanitizeMonitorString(rawVal, 180);
    } else if (Array.isArray(rawVal)) {
      output[safeKey] = rawVal
        .slice(0, 10)
        .filter((item) => typeof item === 'string' || typeof item === 'number')
        .map((item) => (typeof item === 'string' ? sanitizeMonitorString(item, 80) : item));
    } else if (typeof rawVal === 'object') {
      output[safeKey] = sanitizeMonitorContext(rawVal as Record<string, unknown>, depth + 1);
    }
  }

  return output;
}

const SAFE_CATEGORY_LABELS: Record<number, { category: string; summary: string }> = {
  400: { category: 'VALIDATION_FAILED', summary: 'Request validation or input check failed.' },
  401: { category: 'AUTHENTICATION_REQUIRED', summary: 'Authentication token missing, expired, or invalid.' },
  402: { category: 'PAYMENT_REQUIRED', summary: 'Payment or sufficient balance required.' },
  403: { category: 'PERMISSION_DENIED', summary: 'Caller lacks permission for the requested resource.' },
  404: { category: 'RESOURCE_NOT_FOUND', summary: 'Requested route or resource was not found.' },
  409: { category: 'STATE_CONFLICT', summary: 'Request conflicted with current resource or financial state.' },
  413: { category: 'PAYLOAD_TOO_LARGE', summary: 'Request payload exceeded the maximum allowed size.' },
  422: { category: 'UNPROCESSABLE_INPUT', summary: 'Submitted fields could not be processed.' },
  429: { category: 'RATE_LIMITED', summary: 'Request rate limit exceeded.' },
  500: { category: 'INTERNAL_SERVER_ERROR', summary: 'Unhandled internal server error.' },
  502: { category: 'UPSTREAM_BAD_GATEWAY', summary: 'Upstream dependency returned an invalid response.' },
  503: { category: 'SERVICE_UNAVAILABLE', summary: 'Service or upstream dependency was unavailable.' },
  504: { category: 'UPSTREAM_TIMEOUT', summary: 'Upstream service timed out before responding.' },
};

export function resolveSafeCategoryAndSummary(input: {
  statusCode: number;
  errorCategory?: string;
  safeSummary?: string;
  isFinancialRoute?: boolean;
  financialCategory?: string | null;
}): { errorCategory: string; safeSummary: string } {
  const defaults = SAFE_CATEGORY_LABELS[input.statusCode] ?? {
    category: input.statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'HTTP_CLIENT_ERROR',
    summary:
      input.statusCode >= 500
        ? 'Server failed to complete the request.'
        : 'Client request could not be completed.',
  };

  const normalizedCategory = input.errorCategory
    ? input.errorCategory
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 64)
    : input.isFinancialRoute && input.statusCode === 409
      ? `FINANCIAL_${(input.financialCategory || 'OPERATION').toUpperCase()}_CONFLICT`
      : defaults.category;

  const summary = input.safeSummary
    ? sanitizeMonitorString(input.safeSummary, 240)
    : defaults.summary;

  return {
    errorCategory: normalizedCategory || defaults.category,
    safeSummary: summary || defaults.summary,
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint for grouping identical platform errors.
 * Excludes `userId`, `requestId`, `correlationId`, and dynamic route/query parameters.
 */
export function computeErrorFingerprint(input: {
  environment: string;
  service: string;
  httpMethod: string;
  normalizedRoute: string;
  statusCode: number;
  errorCategory: string;
}): string {
  const canonical = [
    input.environment.trim().toLowerCase(),
    input.service.trim().toLowerCase(),
    input.httpMethod.trim().toUpperCase(),
    normalizeErrorRoute(input.normalizedRoute),
    String(input.statusCode),
    input.errorCategory.trim().toUpperCase(),
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

export function buildRailwayLogUrl(input: {
  requestId: string;
  service: string;
  environment: string;
  deploymentId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}): string {
  const filter = encodeURIComponent(`requestId:${input.requestId} service:${input.service}`);
  if (input.projectId && input.environmentId) {
    return `https://railway.com/project/${encodeURIComponent(input.projectId)}/logs?environmentId=${encodeURIComponent(input.environmentId)}&filter=${filter}`;
  }
  return `https://railway.com/logs?environment=${encodeURIComponent(input.environment)}&service=${encodeURIComponent(input.service)}&filter=${filter}`;
}

export function escapeHtml(raw: unknown): string {
  const str = typeof raw === 'string' ? raw : String(raw ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const UUID_V4_OR_ANY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function ensureRequestId(candidate: unknown): string {
  if (typeof candidate === 'string' && UUID_V4_OR_ANY_RE.test(candidate.trim())) {
    return candidate.trim().toLowerCase();
  }
  return randomUUID();
}

export interface RawErrorCaptureInput {
  environment?: ErrorMonitorEnvironment | string;
  service: string;
  source?: ErrorSourceType;
  httpMethod: string;
  route: string;
  statusCode: number;
  errorCategory?: string;
  safeSummary?: string;
  isFinancialRoute?: boolean;
  financialCategory?: FinancialOperationCategory | string | null;
  requestId?: string;
  correlationId?: string | null;
  deploymentId?: string | null;
  upstreamService?: string | null;
  upstreamStatusCode?: number | null;
  actorUserId?: string | null;
  deviceType?: string | null;
  countryCode?: string | null;
  context?: Record<string, unknown> | null;
  occurredAt?: Date | string;
}

export interface SanitizedErrorMonitorEvent {
  fingerprint: string;
  environment: ErrorMonitorEnvironment;
  service: string;
  source: ErrorSourceType;
  httpMethod: string;
  normalizedRoute: string;
  statusCode: number;
  severity: 'critical' | 'error' | 'warning';
  errorCategory: string;
  safeSummary: string;
  isFinancialRoute: boolean;
  financialCategory: string | null;
  emailEligibility: EmailEligibility;
  exclusionReason: EmailExclusionReason | null;
  suppressionWindowMs: number;
  requestId: string;
  correlationId: string;
  deploymentId: string | null;
  upstreamService: string | null;
  upstreamStatusCode: number | null;
  actorUserId: string | null;
  deviceType: string | null;
  countryCode: string | null;
  sanitizedContext: Record<string, unknown>;
  railwayLogUrl: string;
  occurredAt: Date;
}

export const ALLOWLISTED_ERROR_SERVICES = [
  'auth-api',
  'ads-api',
  'billing-api',
  'notifications-api',
  'auth-web',
  'ads-web',
  'billing-web',
  'shop-web',
] as const;

export type AllowlistedErrorService = (typeof ALLOWLISTED_ERROR_SERVICES)[number];

/**
 * Redacts, normalizes, and classifies an incoming error event before persistence or alerting.
 */
export function redactAndSanitizeErrorEvent(
  input: RawErrorCaptureInput,
  env: Record<string, string | undefined> = process.env,
): SanitizedErrorMonitorEvent {
  const environment = (
    input.environment && ['production', 'staging', 'development', 'test'].includes(String(input.environment))
      ? input.environment
      : 'staging'
  ) as ErrorMonitorEnvironment;

  const service = sanitizeMonitorString(input.service || 'unknown-service', 64).toLowerCase() || 'unknown-service';
  const source: ErrorSourceType = input.source === 'browser' ? 'browser' : 'server';
  const httpMethod = sanitizeMonitorString(input.httpMethod || 'GET', 16).toUpperCase() || 'GET';
  const normalizedRoute = normalizeErrorRoute(input.route);
  const statusCode = Number.isInteger(input.statusCode) ? input.statusCode : 500;
  const isFinancialRoute = Boolean(input.isFinancialRoute);
  const financialCategory = input.financialCategory
    ? sanitizeMonitorString(String(input.financialCategory), 48).toLowerCase()
    : null;

  const { errorCategory, safeSummary } = resolveSafeCategoryAndSummary({
    statusCode,
    errorCategory: input.errorCategory,
    safeSummary: input.safeSummary,
    isFinancialRoute,
    financialCategory,
  });

  const decision = classifyErrorEmailEligibility({
    statusCode,
    isFinancialRoute,
    source,
    errorCategory,
  });

  const requestId = ensureRequestId(input.requestId);
  const correlationId = input.correlationId ? ensureRequestId(input.correlationId) : requestId;
  const actorUserId =
    typeof input.actorUserId === 'string' && UUID_SEGMENT_RE.test(input.actorUserId.trim())
      ? input.actorUserId.trim().toLowerCase()
      : null;

  const fingerprint = computeErrorFingerprint({
    environment,
    service,
    httpMethod,
    normalizedRoute,
    statusCode,
    errorCategory,
  });

  const railwayLogUrl = buildRailwayLogUrl({
    requestId,
    service,
    environment,
    deploymentId: input.deploymentId,
    projectId: env.RAILWAY_PROJECT_ID,
    environmentId: env.RAILWAY_ENVIRONMENT_ID,
  });

  const severity: 'critical' | 'error' | 'warning' =
    statusCode >= 500 || (isFinancialRoute && decision.emailEligibility === 'eligible')
      ? statusCode >= 500 && isFinancialRoute
        ? 'critical'
        : 'error'
      : 'warning';

  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt
      : typeof input.occurredAt === 'string' && Number.isFinite(Date.parse(input.occurredAt))
        ? new Date(input.occurredAt)
        : new Date();

  return {
    fingerprint,
    environment,
    service,
    source,
    httpMethod,
    normalizedRoute,
    statusCode,
    severity,
    errorCategory,
    safeSummary,
    isFinancialRoute,
    financialCategory,
    emailEligibility: decision.emailEligibility,
    exclusionReason: decision.exclusionReason,
    suppressionWindowMs: decision.suppressionWindowMs,
    requestId,
    correlationId,
    deploymentId: input.deploymentId ? sanitizeMonitorString(input.deploymentId, 96) : null,
    upstreamService: input.upstreamService ? sanitizeMonitorString(input.upstreamService, 64) : null,
    upstreamStatusCode:
      typeof input.upstreamStatusCode === 'number' && Number.isInteger(input.upstreamStatusCode)
        ? input.upstreamStatusCode
        : null,
    actorUserId,
    deviceType: input.deviceType ? sanitizeMonitorString(input.deviceType, 32) : null,
    countryCode: input.countryCode ? sanitizeMonitorString(input.countryCode, 8).toUpperCase() : null,
    sanitizedContext: sanitizeMonitorContext(input.context),
    railwayLogUrl,
    occurredAt,
  };
}
