import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { JwtPayload } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// @crimfig/shared — NestJS Guards
// ─────────────────────────────────────────────────────────────────────────────

// ── CrimfigAuthGuard ──────────────────────────────────────────────────────────
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
@Injectable()
export class CrimfigAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Run the standard JWT passport validation (verifies signature + expiry)
    const isValid = await super.canActivate(context);
    if (!isValid) return false;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload;

    // Reject non-access tokens (e.g. refresh tokens must not grant API access)
    if (!user || user.type !== 'access') {
      throw new UnauthorizedException('Invalid token type. Access token required.');
    }

    return true;
  }

  /**
   * Override handleRequest so that missing/invalid tokens throw UnauthorizedException
   * with a consistent CrimFig error format rather than NestJS defaults.
   */
  handleRequest<T extends JwtPayload>(err: Error | null, user: T | false): T {
    if (err || !user) {
      throw new UnauthorizedException(err?.message ?? 'Authentication required.');
    }
    return user;
  }
}

// ── Roles Guard ────────────────────────────────────────────────────────────────

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Metadata key for required roles */
export const ROLES_KEY = 'crimfig_required_roles';

/**
 * Decorator to specify the minimum org role required to access a route.
 *
 * Usage:
 *   @Roles('OWNER', 'ADMIN')
 *   @UseGuards(CrimfigAuthGuard, RolesGuard)
 *   deleteOrg() { ... }
 */
export const Roles = (...roles: OrgRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * RolesGuard — enforces organization role requirements on routes decorated with @Roles().
 *
 * IMPORTANT: Must be used AFTER CrimfigAuthGuard so that `request.user` is populated.
 * The org membership context must be resolved by the calling service and attached to
 * `request.orgRole` by an upstream middleware or the controller itself.
 *
 * Role hierarchy: OWNER > ADMIN > MEMBER
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private static readonly HIERARCHY: OrgRole[] = ['MEMBER', 'ADMIN', 'OWNER'];

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<OrgRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() decorator — route is open to any authenticated user
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const userRole: OrgRole | undefined = request.orgRole;

    if (!userRole) {
      throw new ForbiddenException('Organization role context is missing.');
    }

    const userRoleIndex = RolesGuard.HIERARCHY.indexOf(userRole);
    const hasAccess = requiredRoles.some(
      (required) => userRoleIndex >= RolesGuard.HIERARCHY.indexOf(required),
    );

    if (!hasAccess) {
      throw new ForbiddenException(`Insufficient role. Required: ${requiredRoles.join(' or ')}.`);
    }

    return true;
  }
}

// ── AppConsentGuard ────────────────────────────────────────────────────────────

export const REQUIRE_CONSENT_KEY = 'crimfig_require_consent';

/**
 * Marks a route as requiring active app consent from the authenticated user.
 *
 * Usage:
 *   @RequireAppConsent()
 *   @UseGuards(CrimfigAuthGuard, AppConsentGuard)
 *   createCampaign() { ... }
 */
export const RequireAppConsent = () => SetMetadata(REQUIRE_CONSENT_KEY, true);

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
@Injectable()
export class AppConsentGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresConsent = this.reflector.getAllAndOverride<boolean>(REQUIRE_CONSENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiresConsent) return true;

    const request = context.switchToHttp().getRequest();

    if (!request.consentVerified) {
      throw new ForbiddenException({
        error: 'CONSENT_REQUIRED',
        message: 'User has not accepted the current Terms of Service for this application.',
        consentUrl: 'https://auth.crimfig.com/consent',
      });
    }

    return true;
  }
}
