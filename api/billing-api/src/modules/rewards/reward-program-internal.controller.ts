import {
  Body,
  Controller,
  Post,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { Public, FinancialOperation } from "@crimfig/shared";
import { IsUUID, IsIn, IsObject } from "class-validator";
import { timingSafeEqual } from "crypto";
import { RewardProgramService } from "./reward-program.service";
class CommandDto {
  @IsUUID() actorId: string;
  @IsIn([
    "list",
    "propose",
    "approve",
    "convert",
    "receipt",
    "recovery",
    "options",
    "prepareReconciliation",
    "approveReconciliation",
  ])
  action: string;
  @IsObject() input: Record<string, any>;
}
@Public()
@FinancialOperation("settlement")
@Controller("ecosystem/reward-programs")
export class RewardProgramInternalController {
  constructor(private readonly service: RewardProgramService) {}
  @Post() async command(
    @Headers("x-internal-key") key: string,
    @Body() body: CommandDto,
  ) {
    const expected = process.env.INTERNAL_ECOSYSTEM_KEY;
    if (
      !key ||
      !expected ||
      Buffer.byteLength(key) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new UnauthorizedException("Internal rewards authority required");
    const { actorId, action, input } = body;
    let data: any;
    switch (action) {
      case "prepareReconciliation":
        data = await this.service.prepareReconciliation(actorId, input);
        break;
      case "approveReconciliation":
        data = await this.service.approveReconciliation(
          actorId,
          input.id,
          input,
        );
        break;
      case "options":
        data = await this.service.options(actorId);
        break;
      case "list":
        data = await this.service.list(actorId);
        break;
      case "propose":
        data = await this.service.propose(actorId, input);
        break;
      case "approve":
        data = await this.service.approve(actorId, input.id, input);
        break;
      case "convert":
        data = await this.service.convert(actorId, input);
        break;
      case "receipt":
        data = await this.service.receipt(actorId, input.requestId);
        break;
      case "recovery":
        data = await this.service.recovery(actorId, input);
        break;
    }
    return { status: "success", data };
  }
}
