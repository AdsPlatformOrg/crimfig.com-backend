import {
  ReconciliationDto,
  ConversionDto,
  AllocationDto,
  RewardRequestDto,
  RecoveryDto,
} from "../../../../../shared/src/reward-program.dto";
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
  @Post("conversions") async convert(
    @Req() req: any,
    @Body() body: ConversionDto,
  ) {
    return { data: await this.service.conversion(req.user.sub, body) };
  }
  @Get("conversions/options") async options(@Req() req: any) {
    return { data: await this.service.fundedCommand(req.user.sub, "options") };
  }
  @Get("conversions/:id") async receipt(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return {
      data: await this.service.fundedCommand(req.user.sub, "receipt", {
        requestId: id,
      }),
    };
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
  @Post("reconciliations") async prepareReconciliation(
    @Req() req: any,
    @Body() body: ReconciliationDto,
  ) {
    return {
      data: await this.service.fundedCommand(
        req.user.sub,
        "prepareReconciliation",
        body as any,
      ),
    };
  }
  @Post("reconciliations/:id/approve") async approveReconciliation(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RewardRequestDto,
  ) {
    return {
      data: await this.service.fundedCommand(
        req.user.sub,
        "approveReconciliation",
        { ...body, id },
      ),
    };
  }
  @Get("funded-programs") async funded(@Req() req: any) {
    return { data: await this.service.fundedCommand(req.user.sub, "list") };
  }
  @Post("reserve/allocations") async allocate(
    @Req() req: any,
    @Body() body: AllocationDto,
  ) {
    return {
      data: await this.service.fundedCommand(
        req.user.sub,
        "propose",
        body as any,
      ),
    };
  }
  @Post("reserve/allocations/:id/approve") async approveAllocation(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RewardRequestDto,
  ) {
    return {
      data: await this.service.fundedCommand(req.user.sub, "approve", {
        ...body,
        id,
      }),
    };
  }
  @Post("recovery") async recover(@Req() req: any, @Body() body: RecoveryDto) {
    return {
      data: await this.service.fundedCommand(
        req.user.sub,
        "recovery",
        body as any,
      ),
    };
  }
}
