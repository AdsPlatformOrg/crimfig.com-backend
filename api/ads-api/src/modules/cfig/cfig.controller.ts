import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Query,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  IsUUID,
  IsString,
  IsIn,
  MaxLength,
  MinLength,
  IsObject,
  IsOptional,
  IsBoolean,
} from "class-validator";
import { AdsRoles } from "../security/ads-staff-grants";
import { CfigService } from "./cfig.service";
class DecisionDto {
  @IsUUID() requestId: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsIn(["accrue", "reject", "clear", "invalidate"]) action:
    "accrue" | "reject" | "clear" | "invalidate";
  @IsOptional() @IsBoolean() clickAudit?: boolean;
}
class PolicyDto {
  @IsUUID() requestId: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  @IsObject() terms: object;
}
class ApprovalDto {
  @IsUUID() requestId: string;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
@Controller("promoter/rewards/cfig")
export class PromoterCfigController {
  constructor(private readonly service: CfigService) {}
  @Get() async balance(@Req() req: any) {
    return {
      data: await this.service.balances(await this.service.owner(req.user.sub)),
    };
  }
  @Get("transactions") async history(
    @Req() req: any,
    @Query("page") page = "1",
  ) {
    return {
      data: await this.service.history(
        await this.service.owner(req.user.sub),
        Number(page),
      ),
    };
  }
  @Get("allocations") async allocations(
    @Req() req: any,
    @Query("page") page = "1",
  ) {
    return {
      data: await this.service.allocationReport(
        await this.service.owner(req.user.sub),
        Number(page),
      ),
    };
  }
  @Get("badges") async badges(@Req() req: any) {
    return {
      data: await this.service.badgeProgress(
        await this.service.owner(req.user.sub),
      ),
    };
  }
  @Post("conversions") convert() {
    return this.service.conversion();
  }
}
@AdsRoles("super_admin", "ads_finance")
@Controller("admin/rewards/cfig")
export class AdminCfigController {
  constructor(private readonly service: CfigService) {}
  @Get("allocations") async allocations(@Query("page") page = "1") {
    return {
      data: await this.service.allocationReport(undefined, Number(page)),
    };
  }
  @Get("finalizations") async finalizations() {
    return { data: await this.service.finalizationReport() };
  }
  @Post("finalizations/:day") async finalize(
    @Req() req: any,
    @Param("day") day: string,
    @Body() body: ApprovalDto,
  ) {
    return { data: await this.service.finalize(req.user.sub, day, body) };
  }
  @Get("summary") async summary() {
    return { data: await this.service.balances() };
  }
  @Get("transactions") async history(@Query("page") page = "1") {
    return { data: await this.service.history(undefined, Number(page)) };
  }
  @Get("reviews") async reviews(@Query("page") page = "1") {
    return { data: await this.service.reviews(Number(page)) };
  }
  @Get("reviews/:id") async detail(
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return { data: await this.service.reviewDetail(id) };
  }
  @Post("reviews/:id/decision") async decide(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: DecisionDto,
  ) {
    return { data: await this.service.decide(req.user.sub, id, body) };
  }
  @Get("policies") async policies() {
    return { data: await this.service.policies() };
  }
  @Post("policies") async propose(@Req() req: any, @Body() body: PolicyDto) {
    return { data: await this.service.propose(req.user.sub, body) };
  }
  @Post("policies/:id/approve") async approve(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: ApprovalDto,
  ) {
    return { data: await this.service.approve(req.user.sub, id, body) };
  }
  @Get("reserve/allocations") async reserve() {
    return { data: await this.service.reserve() };
  }
  @Post("reserve/allocations") allocate() {
    return this.service.conversion();
  }
}
