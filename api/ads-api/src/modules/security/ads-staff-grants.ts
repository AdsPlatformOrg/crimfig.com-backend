import {
  Injectable,
  Inject,
  SetMetadata,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  readPlatformRoles,
  readPlatformAccounts,
} from "@crimfig/database/schema";
export const ADS_ROLES_KEY = "ads:roles";
export const ADS_STAFF_ROLES = [
  "super_admin",
  "ads_admin",
  "ads_reviewer",
  "ads_manager",
  "ads_finance",
  "ads_support",
  "report_auditor",
  "report_contact_reveal",
] as const;
export type AdsStaffRole = (typeof ADS_STAFF_ROLES)[number];
export const AdsRoles = (...roles: AdsStaffRole[]) =>
  SetMetadata(ADS_ROLES_KEY, roles);
@Injectable()
export class AdsStaffGrants {
  constructor(@Inject("DATABASE_CONNECTION") private readonly db: any) {}
  async rolesFor(id: string, conn: any = this.db): Promise<AdsStaffRole[]> {
    try {
      return (
        await readPlatformRoles(conn, id, "ads", conn !== this.db)
      ).filter((role): role is AdsStaffRole =>
        ADS_STAFF_ROLES.includes(role as AdsStaffRole),
      );
    } catch {
      throw new ServiceUnavailableException(
        "Platform access authority is unavailable",
      );
    }
  }
  async accountsWithRole(role: AdsStaffRole): Promise<string[]> {
    try {
      return await readPlatformAccounts(this.db, role, "ads");
    } catch {
      throw new ServiceUnavailableException(
        "Platform access authority is unavailable",
      );
    }
  }
}
