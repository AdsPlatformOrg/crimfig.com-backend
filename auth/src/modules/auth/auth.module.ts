import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { EmailTemplatesController } from '../email/email-templates.controller';
import { AuthStaffRoleGuard } from '../../security/auth-staff-role.guard';
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
  controllers: [AuthController, EmailTemplatesController],
  providers: [AuthService, JwtStrategy, AuthStaffGrants, AuthStaffRoleGuard],
  exports: [AuthService, AuthStaffGrants],
})
export class AuthModule {}

