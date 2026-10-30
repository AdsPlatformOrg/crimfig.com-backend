// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — Public API
//
// All other backend services import from '@crimfig/shared', not from
// individual subpaths. This barrel keeps the public surface clean.
// ─────────────────────────────────────────────────────────────────────────────

// Types
export type {
  JwtPayload,
  AuthenticatedUser,
  OrgMembership,
  OrgRole,
  AppConsentRecord,
  MfaDeviceType,
  PaginationMeta,
  PaginatedResponse,
  ApiSuccessResponse,
  ApiErrorResponse,
} from './types';

// DTOs
export {
  LoginDto,
  RegisterDto,
  RefreshTokenDto,
  MfaChallengeDto,
  TokenPairResponseDto,
  PaginationQueryDto,
  CreateOrganizationDto,
} from './dto';

// Guards
export {
  CrimfigAuthGuard,
  RolesGuard,
  AppConsentGuard,
  Roles,
  RequireAppConsent,
  ROLES_KEY,
  REQUIRE_CONSENT_KEY,
} from './guards';

// Decorators
export {
  CurrentUser,
  Public,
  ApiVersion,
  IS_PUBLIC_KEY,
  API_VERSION_KEY,
} from './decorators';

// Logger
export { CrimfigLogger } from './logger';
export type { LogLevel, LogEntry } from './logger';

// Default-deny first-party dashboard authentication (not publisher ad delivery).
export { AccessTokenGuard, DashboardAuthModule } from './security/access-token.guard';
export { dashboardOrigins, validateDashboardOrigins } from './security/dashboard-origins';

// Platform Error Monitor & Alerting (PLAN-0045)
export {
  DEFAULT_ERROR_ALERT_RECIPIENTS,
  DEFAULT_SUPPRESSION_WINDOW_MS,
  REFUSED_INPUT_SUPPRESSION_WINDOW_MS,
  MAX_OCCURRENCE_SAMPLES_PER_GROUP,
  resolveErrorAlertRecipients,
  resolveErrorMonitorEnvironment,
  resolveErrorMonitorConfig,
} from './monitoring/error-alert.config';
export type {
  ErrorMonitorEnvironment,
  ErrorMonitorRuntimeConfig,
} from './monitoring/error-alert.config';
export {
  FINANCIAL_OPERATION_KEY,
  FinancialOperation,
  ALLOWLISTED_ERROR_SERVICES,
  classifyErrorEmailEligibility,
  normalizeErrorRoute,
  sanitizeMonitorString,
  sanitizeMonitorContext,
  resolveSafeCategoryAndSummary,
  computeErrorFingerprint,
  buildRailwayLogUrl,
  escapeHtml,
  ensureRequestId,
  redactAndSanitizeErrorEvent,
} from './monitoring/error-monitor.contract';
export type {
  FinancialOperationCategory,
  FinancialOperationMetadata,
  ErrorSourceType,
  EmailEligibility,
  EmailExclusionReason,
  NotificationDeliveryState,
  EmailEligibilityDecision,
  RawErrorCaptureInput,
  SanitizedErrorMonitorEvent,
  AllowlistedErrorService,
} from './monitoring/error-monitor.contract';
export { ErrorMonitorCaptureInterceptor } from './monitoring/error-monitor.interceptor';
export type { ErrorMonitorSink } from './monitoring/error-monitor.interceptor';
