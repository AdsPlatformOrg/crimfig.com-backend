import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators';
import type { JwtPayload } from '../types';

/** Default-deny API guard. Public routes retain their own provider/service checks. */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(protected readonly jwt: JwtService, protected readonly reflector: Reflector) {}

  protected isPublic(context: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]) === true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;
    const request = context.switchToHttp().getRequest();
    // Never trust pre-populated/header-derived identity before signature validation.
    delete request.user;
    const header: unknown = request.headers?.authorization;
    if (typeof header !== 'string' || header.length > 8192 || !/^Bearer [^\s]+$/i.test(header)) {
      throw new UnauthorizedException('A bearer access token is required');
    }
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7), { algorithms: ['HS256'] });
      if (payload.type !== 'access' || typeof payload.sub !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub) ||
          typeof payload.email !== 'string' || !payload.email ||
          typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('Invalid access claims');
      }
      request.user = { sub: payload.sub, email: payload.email, type: 'access' };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

/** Import into first-party API modules, then register the scoped APP_GUARD there. */
@Module({
  imports: [JwtModule.registerAsync({
    useFactory: () => {
      const secret = process.env.JWT_ACCESS_SECRET;
      if (!secret) throw new Error('JWT_ACCESS_SECRET is required for dashboard authentication');
      return { secret, verifyOptions: { algorithms: ['HS256'] } };
    },
  })],
  providers: [AccessTokenGuard],
  exports: [JwtModule, AccessTokenGuard],
})
export class DashboardAuthModule {}
