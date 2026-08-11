import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '../types';
declare const CrimfigAuthGuard_base: import("@nestjs/passport").Type<import("@nestjs/passport").IAuthGuard>;
/**
 * Primary JWT authentication guard for all CrimFig microservices.
 *
 * - Validates the Bearer token in the `Authorization` header using the 'jwt' Passport strategy.
 * - Rejects tokens whose `type` is not 'access' (e.g., refresh or mfa_challenge tokens).
 * - Attaches the decoded `JwtPayload` to `request.user`.
 *
 * Usage:
 *   @UseGuards(CrimfigAuthGuard)
 *   @Get('protected-route')
 *   getProtected(@CurrentUser() user: JwtPayload) { ... }
 */
export declare class CrimfigAuthGuard extends CrimfigAuthGuard_base {
    canActivate(context: ExecutionContext): Promise<boolean>;
    /**
     * Override handleRequest so that missing/invalid tokens throw UnauthorizedException
     * with a consistent CrimFig error format rather than NestJS defaults.
     */
    handleRequest<T extends JwtPayload>(err: Error | null, user: T | false): T;
}
export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
/** Metadata key for required roles */
export declare const ROLES_KEY = "crimfig_required_roles";
/**
 * Decorator to specify the minimum org role required to access a route.
 *
 * Usage:
 *   @Roles('OWNER', 'ADMIN')
 *   @UseGuards(CrimfigAuthGuard, RolesGuard)
 *   deleteOrg() { ... }
 */
export declare const Roles: (...roles: OrgRole[]) => import("@nestjs/common").CustomDecorator<string>;
/**
 * RolesGuard — enforces organization role requirements on routes decorated with @Roles().
 *
 * IMPORTANT: Must be used AFTER CrimfigAuthGuard so that `request.user` is populated.
 * The org membership context must be resolved by the calling service and attached to
 * `request.orgRole` by an upstream middleware or the controller itself.
 *
 * Role hierarchy: OWNER > ADMIN > MEMBER
 */
export declare class RolesGuard implements CanActivate {
    private readonly reflector;
    private static readonly HIERARCHY;
    constructor(reflector: Reflector);
    canActivate(context: ExecutionContext): boolean;
}
export declare const REQUIRE_CONSENT_KEY = "crimfig_require_consent";
/**
 * Marks a route as requiring active app consent from the authenticated user.
 *
 * Usage:
 *   @RequireAppConsent()
 *   @UseGuards(CrimfigAuthGuard, AppConsentGuard)
 *   createCampaign() { ... }
 */
export declare const RequireAppConsent: () => import("@nestjs/common").CustomDecorator<string>;
/**
 * AppConsentGuard — verifies that the user has accepted the current Terms of Service
 * for the app they are accessing.
 *
 * Requires `request.consentVerified: boolean` to be set by an upstream interceptor
 * or middleware that checks `user_app_consents` for the current user + appClientId.
 *
 * If consent is missing, returns 403 with a structured response that the frontend
 * can detect and redirect the user to the consent flow at auth.crimfig.com.
 */
export declare class AppConsentGuard implements CanActivate {
    private readonly reflector;
    constructor(reflector: Reflector);
    canActivate(context: ExecutionContext): boolean;
}
export {};
//# sourceMappingURL=index.d.ts.map