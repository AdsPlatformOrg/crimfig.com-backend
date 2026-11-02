import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ReconciliationDto,
  RewardRequestDto,
  ConversionDto,
  AllocationDto,
  PaidDto,
  ClearanceDto,
  RecoveryDto,
} from "../../../../../shared/src/reward-program.dto";
import { FinancialOperation } from "@crimfig/shared";
import { RewardProgramService } from "./reward-program.service";
@FinancialOperation("settlement")
@Controller("rewards/programs")
export class RewardProgramController {
  constructor(private readonly service: RewardProgramService) {}
  @Get() async list(@Req() req: any) {
    return { data: await this.service.list(req.user.sub) };
  }
  @Post("reconciliations") async prepareReconciliation(
    @Req() req: any,
    @Body() body: ReconciliationDto,
  ) {
    return {
      data: await this.service.prepareReconciliation(req.user.sub, body),
    };
  }
  @Post("reconciliations/:id/approve") async approveReconciliation(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RewardRequestDto,
  ) {
    return {
      data: await this.service.approveReconciliation(req.user.sub, id, body),
    };
  }
  @Post("allocations") async propose(
    @Req() req: any,
    @Body() body: AllocationDto,
  ) {
    return { data: await this.service.propose(req.user.sub, body) };
  }
  @Post("allocations/:id/approve") async approve(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: RewardRequestDto,
  ) {
    return { data: await this.service.approve(req.user.sub, id, body) };
  }
  @Post("paid-events/:id") async paid(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: PaidDto,
  ) {
    return { data: await this.service.processPaid(req.user.sub, id, body) };
  }
  @Post("clearance/:id") async clear(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: ClearanceDto,
  ) {
    return { data: await this.service.clearLegacy(req.user.sub, id, body) };
  }
  @Get("conversion-options") async options(@Req() req: any) {
    return { data: await this.service.options(req.user.sub) };
  }
  @Post("conversions") async convert(
    @Req() req: any,
    @Body() body: ConversionDto,
  ) {
    return { data: await this.service.convert(req.user.sub, body) };
  }
  @Get("receipts/:id") async receipt(
    @Req() req: any,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return { data: await this.service.receipt(req.user.sub, id) };
  }
  @Post("recovery") async recovery(@Req() req: any, @Body() body: RecoveryDto) {
    return { data: await this.service.recovery(req.user.sub, body) };
  }
}
