import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensModule } from '../tokens/tokens.module';
import { JwtStrategy } from '../../strategies/jwt.strategy';
import { config } from '../../config/config';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    TokensModule,
    // JwtService needed for email-purpose token signing (verify + password reset)
    JwtModule.register({ secret: config.JWT.ACCESS_SECRET }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
