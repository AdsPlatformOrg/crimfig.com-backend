import {
  Inject,
  Injectable,
  SetMetadata,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readPlatformRoles } from "@crimfig/database/schema";
export const BILLING_ROLES_KEY = "billing:roles";
export const BILLING_STAFF_ROLES = [
  "super_admin",
  "billing_admin",
  "billing_manager",
  "billing_support",
  "billing_auditor",
] as const;
export type BillingStaffRole = (typeof BILLING_STAFF_ROLES)[number];
export const BillingRoles = (...roles: BillingStaffRole[]) =>
  SetMetadata(BILLING_ROLES_KEY, roles);
@Injectable()
export class BillingStaffGrants {
  constructor(@Inject("DATABASE_CONNECTION") private readonly db: any) {}
  async rolesFor(id: string, conn: any = this.db): Promise<BillingStaffRole[]> {
    try {
      return (
        await readPlatformRoles(conn, id, "billing", conn !== this.db)
      ).filter((role): role is BillingStaffRole =>
        BILLING_STAFF_ROLES.includes(role as BillingStaffRole),
      );
    } catch {
      throw new ServiceUnavailableException(
        "Platform access authority is unavailable",
      );
    }
  }
}
