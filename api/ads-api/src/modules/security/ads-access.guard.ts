import { Inject, Injectable, UnauthorizedException, ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenGuard } from '@crimfig/shared';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';
import { ADS_ROLES_KEY, AdsStaffGrants, AdsStaffRole } from './ads-staff-grants';

@Injectable()
export class AdsAccessGuard extends AccessTokenGuard {
  constructor(jwt: JwtService, reflector: Reflector,
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly staff: AdsStaffGrants) { super(jwt, reflector); }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (this.isPublic(context)) { delete request.user; return true; }
    await super.canActivate(context);
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, request.user.sub), columns: { id: true, email: true, status: true },
    });
    if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
      delete request.user;
      throw new UnauthorizedException('Account is not available');
    }
    request.user = { sub: user.id, email: user.email, type: 'access' };
    const required = this.reflector.getAllAndOverride<AdsStaffRole[]>(ADS_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (required?.length && !required.some(role => this.staff.rolesFor(user.id).includes(role))) {
      throw new ForbiddenException('This action requires an assigned Ads staff role');
    }
    return true;
  }
}
