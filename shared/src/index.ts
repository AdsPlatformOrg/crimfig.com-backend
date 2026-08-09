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
