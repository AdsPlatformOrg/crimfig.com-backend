import { Module } from '@nestjs/common';
import { MfaModule } from '../mfa/mfa.module';
import { FinancialAuthorizationController } from './financial-authorization.controller';
import { FinancialAuthorizationService } from './financial-authorization.service';
@Module({ imports: [MfaModule], controllers: [FinancialAuthorizationController], providers: [FinancialAuthorizationService] })
export class FinancialAuthorizationModule {}
