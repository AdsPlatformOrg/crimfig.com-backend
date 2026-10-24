import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensModule } from '../tokens/tokens.module';
import { JwtStrategy } from '../../strategies/jwt.strategy';
import { config } from '../../config/config';

import { AuthStaffGrants } from '../../security/auth-staff-grants';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    TokensModule,
    // JwtService needed for email-purpose token signing (verify + password reset)
    JwtModule.register({ secret: config.JWT.ACCESS_SECRET }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, AuthStaffGrants],
  exports: [AuthService, AuthStaffGrants],
})
export class AuthModule {}

