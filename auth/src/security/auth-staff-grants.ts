import {
  Injectable,
  Inject,
  SetMetadata,
  ServiceUnavailableException,
} from "@nestjs/common";
import { readPlatformRoles } from "@crimfig/database/schema";
export const AUTH_ROLES_KEY = "auth:roles";
export const AUTH_STAFF_ROLES = [
  "super_admin",
  "auth_admin",
  "security_admin",
  "compliance_officer",
  "support_agent",
] as const;
export type AuthStaffRole = (typeof AUTH_STAFF_ROLES)[number];
export const AuthRoles = (...roles: AuthStaffRole[]) =>
  SetMetadata(AUTH_ROLES_KEY, roles);
@Injectable()
export class AuthStaffGrants {
  constructor(@Inject("DATABASE") private readonly db?: any) {}
  async rolesFor(id: string, conn: any = this.db): Promise<AuthStaffRole[]> {
    try {
      return (
        await readPlatformRoles(conn, id, "auth", conn !== this.db)
      ).filter((role): role is AuthStaffRole =>
        AUTH_STAFF_ROLES.includes(role as AuthStaffRole),
      );
    } catch {
      throw new ServiceUnavailableException(
        "Platform access authority is unavailable",
      );
    }
  }
}
