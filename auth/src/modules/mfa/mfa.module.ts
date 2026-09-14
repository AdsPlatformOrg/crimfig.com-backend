import { Module } from '@nestjs/common';
import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { TokensModule } from '../tokens/tokens.module';

@Module({
  imports: [TokensModule],
  controllers: [MfaController],
  providers: [MfaService],
  exports: [MfaService],
})
export class MfaModule {}

