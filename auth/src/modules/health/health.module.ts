import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { OAuthModule } from '../oauth/oauth.module';

@Module({
  imports: [OAuthModule],
  controllers: [HealthController],
})
export class HealthModule {}
