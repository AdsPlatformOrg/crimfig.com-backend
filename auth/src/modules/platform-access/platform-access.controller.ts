import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from "class-validator";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { JwtAuthGuard } from "../../guards/jwt-auth.guard";
import { PlatformAccessService } from "./platform-access.service";
class ProposalDto {
  @IsUUID() requestId!: string;
  @IsUUID() targetUserId!: string;
  @IsString() @MaxLength(60) roleKey!: string;
  @IsIn(["ads", "auth", "billing", "auth_finance"]) scope!:
    "ads" | "auth" | "billing" | "auth_finance";
  @IsIn(["grant", "revoke"]) action!: "grant" | "revoke";
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @IsOptional() @IsISO8601() grantExpiresAt?: string;
  @IsString() @Length(6, 6) code!: string;
}
class DecisionDto {
  @IsIn(["approve", "reject"]) decision!: "approve" | "reject";
  @IsString() @Length(6, 6) code!: string;
}
@ApiTags("Platform access")
@Controller({ path: "auth/platform-access", version: "1" })
@UseGuards(JwtAuthGuard, ThrottlerGuard)
export class PlatformAccessController {
  constructor(private readonly access: PlatformAccessService) {}
  @Get()
  @Header("Cache-Control", "no-store")
  async overview(@Req() req: any) {
    return {
      status: "success",
      data: await this.access.overview(req.user.sub),
    };
  }
  @Post("proposals")
  @Header("Cache-Control", "no-store")
  @Throttle({
    short: { limit: 3, ttl: 60000 },
    medium: { limit: 6, ttl: 60000 },
  })
  async propose(@Req() req: any, @Body() body: ProposalDto) {
    return {
      status: "success",
      data: await this.access.propose(req.user.sub, body),
    };
  }
  @Post("proposals/:id/decision")
  @Header("Cache-Control", "no-store")
  @Throttle({
    short: { limit: 3, ttl: 60000 },
    medium: { limit: 6, ttl: 60000 },
  })
  async decide(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: DecisionDto,
  ) {
    return {
      status: "success",
      data: await this.access.decide(req.user.sub, id, body),
    };
  }
}
