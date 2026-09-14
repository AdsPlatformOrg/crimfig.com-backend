import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { config } from '../config/config';
import type { JwtPayload } from '../modules/tokens/tokens.service';

@Injectable()
export class MfaChallengeGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed MFA challenge token');
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: config.JWT.ACCESS_SECRET,
      });

      if (payload.type !== 'mfa_challenge') {
        throw new UnauthorizedException('Invalid token type: expected MFA challenge');
      }

      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA challenge token');
    }
  }
}
