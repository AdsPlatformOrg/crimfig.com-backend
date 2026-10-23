import { Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const ADS_ROLES_KEY = 'ads:roles';
export const ADS_STAFF_ROLES = ['super_admin', 'ads_admin', 'ads_reviewer', 'ads_manager', 'ads_finance', 'ads_support'] as const;
export type AdsStaffRole = typeof ADS_STAFF_ROLES[number];
/** An empty method list overrides a staff-only class for owner-scoped routes. */
export const AdsRoles = (...roles: AdsStaffRole[]) => SetMetadata(ADS_ROLES_KEY, roles);

@Injectable()
export class AdsStaffGrants {
  private readonly grants = new Map<string, readonly AdsStaffRole[]>();

  constructor(config: ConfigService) {
    const raw: unknown = JSON.parse(config.get<string>('ADS_STAFF_ROLE_GRANTS') || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ADS_STAFF_ROLE_GRANTS must be a UUID-to-role-array JSON object');
    for (const [id, roles] of Object.entries(raw)) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
          !Array.isArray(roles) || !roles.every(role => ADS_STAFF_ROLES.includes(role))) {
        throw new Error('ADS_STAFF_ROLE_GRANTS contains an invalid account or role');
      }
      this.grants.set(id.toLowerCase(), Object.freeze([...new Set(roles)]));
    }
  }

  rolesFor(id: string): readonly AdsStaffRole[] { return this.grants.get(id.toLowerCase()) || []; }
}
