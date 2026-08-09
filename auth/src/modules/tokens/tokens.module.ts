import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokensService } from './tokens.service';
import { config } from '../../config/config';

@Module({
  imports: [
    JwtModule.register({
      secret: config.JWT.ACCESS_SECRET,
      signOptions: { expiresIn: config.JWT.ACCESS_EXPIRES_IN },
    }),
  ],
  providers: [TokensService],
  exports: [TokensService, JwtModule],
})
export class TokensModule {}
