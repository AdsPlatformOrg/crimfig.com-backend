import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { MfaModule } from "../mfa/mfa.module";
import { PlatformAccessController } from "./platform-access.controller";
import { PlatformAccessService } from "./platform-access.service";
@Module({
  imports: [MfaModule, PassportModule],
  controllers: [PlatformAccessController],
  providers: [PlatformAccessService],
})
export class PlatformAccessModule {}
