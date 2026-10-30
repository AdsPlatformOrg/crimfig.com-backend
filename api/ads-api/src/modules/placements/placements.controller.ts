import { Controller, Get, Post, Body, Req } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PlacementsService } from "./placements.service";
import { PromotersService } from "../promoters/promoters.service";
import { IsString, IsOptional, IsInt, Min, Max } from "class-validator";

export class CreatePlacementDto {
  @IsOptional() @IsInt() @Min(1000) @Max(300000) imageMaxBytes?: number;
  @IsString()
  campaignId: string;

  @IsOptional()
  @IsString()
  creativeId?: string;

  @IsOptional()
  @IsString()
  websiteId?: string;

  @IsOptional()
  @IsString()
  appId?: string;
}

@ApiTags("Placements")
@Controller("placements")
export class PlacementsController {
  constructor(
    private readonly placementsService: PlacementsService,
    private readonly promotersService: PromotersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Get all active placements and embed codes for promoter",
  })
  async getPlacements(@Req() req: any) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId);
    const placements = await this.placementsService.getPromoterPlacements(
      promoter.id,
    );
    return { status: "success", data: placements };
  }

  @Post()
  @ApiOperation({
    summary:
      "Apply to campaign and generate placement embed code or share link",
  })
  async createPlacement(@Req() req: any, @Body() dto: CreatePlacementDto) {
    const userId = req.user.sub;
    const promoter = await this.promotersService.getOrCreatePromoter(userId);
    const placement = await this.placementsService.createPlacement({
      promoterId: promoter.id,
      campaignId: dto.campaignId,
      creativeId: dto.creativeId,
      websiteId: dto.websiteId,
      appId: dto.appId,
      imageMaxBytes: dto.imageMaxBytes,
    });
    return { status: "success", data: placement };
  }
}
