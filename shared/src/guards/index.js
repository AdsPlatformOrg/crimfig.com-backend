"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RolesGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppConsentGuard = exports.RequireAppConsent = exports.REQUIRE_CONSENT_KEY = exports.RolesGuard = exports.Roles = exports.ROLES_KEY = exports.CrimfigAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const passport_1 = require("@nestjs/passport");
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
let CrimfigAuthGuard = class CrimfigAuthGuard extends (0, passport_1.AuthGuard)('jwt') {
    async canActivate(context) {
        // Run the standard JWT passport validation (verifies signature + expiry)
        const isValid = await super.canActivate(context);
        if (!isValid)
            return false;
        const request = context.switchToHttp().getRequest();
        const user = request.user;
        // Reject non-access tokens (e.g. refresh tokens must not grant API access)
        if (!user || user.type !== 'access') {
            throw new common_1.UnauthorizedException('Invalid token type. Access token required.');
        }
        return true;
    }
    /**
     * Override handleRequest so that missing/invalid tokens throw UnauthorizedException
     * with a consistent CrimFig error format rather than NestJS defaults.
     */
    handleRequest(err, user) {
        if (err || !user) {
            throw new common_1.UnauthorizedException(err?.message ?? 'Authentication required.');
        }
        return user;
    }
};
exports.CrimfigAuthGuard = CrimfigAuthGuard;
exports.CrimfigAuthGuard = CrimfigAuthGuard = __decorate([
    (0, common_1.Injectable)()
], CrimfigAuthGuard);
/** Metadata key for required roles */
exports.ROLES_KEY = 'crimfig_required_roles';
/**
 * Decorator to specify the minimum org role required to access a route.
 *
 * Usage:
 *   @Roles('OWNER', 'ADMIN')
 *   @UseGuards(CrimfigAuthGuard, RolesGuard)
 *   deleteOrg() { ... }
 */
const Roles = (...roles) => (0, common_1.SetMetadata)(exports.ROLES_KEY, roles);
exports.Roles = Roles;
/**
 * RolesGuard — enforces organization role requirements on routes decorated with @Roles().
 *
 * IMPORTANT: Must be used AFTER CrimfigAuthGuard so that `request.user` is populated.
 * The org membership context must be resolved by the calling service and attached to
 * `request.orgRole` by an upstream middleware or the controller itself.
 *
 * Role hierarchy: OWNER > ADMIN > MEMBER
 */
let RolesGuard = class RolesGuard {
    static { RolesGuard_1 = this; }
    reflector;
    static HIERARCHY = ['MEMBER', 'ADMIN', 'OWNER'];
    constructor(reflector) {
        this.reflector = reflector;
    }
    canActivate(context) {
        const requiredRoles = this.reflector.getAllAndOverride(exports.ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        // No @Roles() decorator — route is open to any authenticated user
        if (!requiredRoles || requiredRoles.length === 0)
            return true;
        const request = context.switchToHttp().getRequest();
        const userRole = request.orgRole;
        if (!userRole) {
            throw new common_1.ForbiddenException('Organization role context is missing.');
        }
        const userRoleIndex = RolesGuard_1.HIERARCHY.indexOf(userRole);
        const hasAccess = requiredRoles.some((required) => userRoleIndex >= RolesGuard_1.HIERARCHY.indexOf(required));
        if (!hasAccess) {
            throw new common_1.ForbiddenException(`Insufficient role. Required: ${requiredRoles.join(' or ')}.`);
        }
        return true;
    }
};
exports.RolesGuard = RolesGuard;
exports.RolesGuard = RolesGuard = RolesGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector])
], RolesGuard);
// ── AppConsentGuard ────────────────────────────────────────────────────────────
exports.REQUIRE_CONSENT_KEY = 'crimfig_require_consent';
/**
 * Marks a route as requiring active app consent from the authenticated user.
 *
 * Usage:
 *   @RequireAppConsent()
 *   @UseGuards(CrimfigAuthGuard, AppConsentGuard)
 *   createCampaign() { ... }
 */
const RequireAppConsent = () => (0, common_1.SetMetadata)(exports.REQUIRE_CONSENT_KEY, true);
exports.RequireAppConsent = RequireAppConsent;
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
let AppConsentGuard = class AppConsentGuard {
    reflector;
    constructor(reflector) {
        this.reflector = reflector;
    }
    canActivate(context) {
        const requiresConsent = this.reflector.getAllAndOverride(exports.REQUIRE_CONSENT_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!requiresConsent)
            return true;
        const request = context.switchToHttp().getRequest();
        if (!request.consentVerified) {
            throw new common_1.ForbiddenException({
                error: 'CONSENT_REQUIRED',
                message: 'User has not accepted the current Terms of Service for this application.',
                consentUrl: 'https://auth.crimfig.com/consent',
            });
        }
        return true;
    }
};
exports.AppConsentGuard = AppConsentGuard;
exports.AppConsentGuard = AppConsentGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector])
], AppConsentGuard);
//# sourceMappingURL=index.js.map