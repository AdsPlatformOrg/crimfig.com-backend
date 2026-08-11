/**
 * Payload embedded in every CrimFig JWT (access, refresh, mfa_challenge).
 * This is the single source of truth for the JWT payload shape — all services
 * that validate CrimFig tokens must use this interface.
 */
export interface JwtPayload {
    /** userId (UUID) */
    sub: string;
    email: string;
    /** Token purpose — allows services to reject non-access tokens on protected routes */
    type: 'access' | 'refresh' | 'mfa_challenge';
    /** Optional: which app client initiated this session */
    appClientId?: string;
    /** Optional: device fingerprint bound to this token */
    deviceFingerprint?: string;
    /** Issued-at timestamp (seconds since epoch) — set automatically by JwtService */
    iat?: number;
    /** Expiry timestamp (seconds since epoch) — set automatically by JwtService */
    exp?: number;
}
/** Short, serializable representation of an authenticated user attached to req.user */
export interface AuthenticatedUser {
    id: string;
    email: string;
    appClientId?: string;
}
export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export interface OrgMembership {
    organizationId: string;
    role: OrgRole;
    joinedAt: Date;
}
export interface AppConsentRecord {
    userId: string;
    appId: string;
    termsVersionAccepted: string;
    agreedAt: Date;
}
export type MfaDeviceType = 'TOTP' | 'PASSKEY' | 'SMS';
export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}
export interface PaginatedResponse<T> {
    data: T[];
    meta: PaginationMeta;
}
export interface ApiSuccessResponse<T = void> {
    success: true;
    data: T;
    message?: string;
}
export interface ApiErrorResponse {
    success: false;
    error: string;
    message: string;
    statusCode: number;
}
//# sourceMappingURL=index.d.ts.map