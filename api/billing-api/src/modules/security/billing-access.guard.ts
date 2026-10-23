import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenGuard } from '@crimfig/shared';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { eq } from 'drizzle-orm';
import { DATABASE_TOKEN } from '../database/database.module';

@Injectable()
export class BillingAccessGuard extends AccessTokenGuard {
  constructor(jwt: JwtService, reflector: Reflector,
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>) {
    super(jwt, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;
    await super.canActivate(context);
    const request = context.switchToHttp().getRequest();
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, request.user.sub),
      columns: { id: true, email: true, status: true },
    });
    if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
      delete request.user;
      throw new UnauthorizedException('Account is not available');
    }
    request.user = { sub: user.id, email: user.email, type: 'access' };
    return true;
  }
}
