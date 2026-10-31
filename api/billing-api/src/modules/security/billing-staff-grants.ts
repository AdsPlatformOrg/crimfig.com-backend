import { Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const BILLING_ROLES_KEY = 'billing:roles';
export const BILLING_STAFF_ROLES = [
  'super_admin',
  'billing_admin',
  'billing_manager',
  'billing_support',
  'billing_auditor',
] as const;

export type BillingStaffRole = typeof BILLING_STAFF_ROLES[number];

export const BillingRoles = (...roles: BillingStaffRole[]) =>
  SetMetadata(BILLING_ROLES_KEY, roles);

@Injectable()
export class BillingStaffGrants {
  private readonly grants = new Map<string, readonly BillingStaffRole[]>();

  constructor(config: ConfigService) {
    const raw: unknown = JSON.parse(
      config.get<string>('BILLING_STAFF_ROLE_GRANTS') ||
      '{}'
    );

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(
        'BILLING_STAFF_ROLE_GRANTS must be a UUID-to-role-array JSON object'
      );
    }

    for (const [id, roles] of Object.entries(raw)) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        !Array.isArray(roles)
      ) {
        throw new Error('BILLING_STAFF_ROLE_GRANTS contains an invalid account entry');
      }

      // Map compatible staff roles
      const mappedRoles: BillingStaffRole[] = [];
      for (const r of roles) {
        if (BILLING_STAFF_ROLES.includes(r as BillingStaffRole)) {
          mappedRoles.push(r as BillingStaffRole);
        }
      }

      this.grants.set(id.toLowerCase(), Object.freeze([...new Set(mappedRoles)]));
    }
  }

  rolesFor(id: string): readonly BillingStaffRole[] {
    return this.grants.get(id.toLowerCase()) || [];
  }
}
