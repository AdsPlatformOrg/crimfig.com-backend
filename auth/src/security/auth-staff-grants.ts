import { Injectable, SetMetadata } from '@nestjs/common';

export const AUTH_ROLES_KEY = 'auth:roles';
export const AUTH_STAFF_ROLES = [
  'super_admin',
  'auth_admin',
  'security_admin',
  'compliance_officer',
  'support_agent',
] as const;

export type AuthStaffRole = typeof AUTH_STAFF_ROLES[number];

export const AuthRoles = (...roles: AuthStaffRole[]) =>
  SetMetadata(AUTH_ROLES_KEY, roles);

@Injectable()
export class AuthStaffGrants {
  private readonly grants = new Map<string, readonly AuthStaffRole[]>();

  constructor() {
    const rawEnv =
      process.env.AUTH_STAFF_ROLE_GRANTS ||
      process.env.ADS_STAFF_ROLE_GRANTS ||
      '{}';

    let raw: unknown = {};
    try {
      raw = JSON.parse(rawEnv);
    } catch {
      raw = {};
    }

    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, roles] of Object.entries(raw)) {
        if (
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
          Array.isArray(roles)
        ) {
          const mapped: AuthStaffRole[] = [];
          for (const r of roles) {
            if (AUTH_STAFF_ROLES.includes(r as AuthStaffRole)) {
              mapped.push(r as AuthStaffRole);
            } else if (r === 'super_admin') {
              mapped.push('super_admin');
            } else if (r === 'ads_admin' || r === 'billing_admin') {
              mapped.push('auth_admin');
            } else if (r === 'ads_support' || r === 'billing_support') {
              mapped.push('support_agent');
            }
          }
          this.grants.set(id.toLowerCase(), Object.freeze([...new Set(mapped)]));
        }
      }
    }
  }

  rolesFor(id: string): readonly AuthStaffRole[] {
    return this.grants.get(id.toLowerCase()) || [];
  }
}
