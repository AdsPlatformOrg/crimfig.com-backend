import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { config } from '../config/config';
import type { JwtPayload } from '../modules/tokens/tokens.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.JWT.ACCESS_SECRET,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // Only accept full access tokens, not mfa_challenge tokens
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    return payload;
  }
}
