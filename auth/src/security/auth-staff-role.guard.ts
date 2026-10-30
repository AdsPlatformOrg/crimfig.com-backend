import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUTH_ROLES_KEY,
  AuthStaffGrants,
  type AuthStaffRole,
} from './auth-staff-grants';

/**
 * Enforces explicit `@AuthRoles(...)` staff role assignments on Auth controller routes.
 * Fails closed with `403 Forbidden` when the authenticated user lacks one of the required roles.
 */
@Injectable()
export class AuthStaffRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly staffGrants: AuthStaffGrants,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AuthStaffRole[]>(
      AUTH_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userId = request?.user?.sub;
    if (typeof userId !== 'string' || !userId.trim()) {
      throw new ForbiddenException('Platform Administrator authorization is required.');
    }

    const assignedRoles = this.staffGrants.rolesFor(userId);
    const hasRequiredRole = requiredRoles.some((role) => assignedRoles.includes(role));
    if (!hasRequiredRole) {
      throw new ForbiddenException(
        `Access denied: requires ${requiredRoles.join(' or ')} privilege.`,
      );
    }

    return true;
  }
}
