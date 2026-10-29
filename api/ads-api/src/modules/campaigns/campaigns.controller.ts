import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiQuery } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { CampaignsService } from "./campaigns.service";
import { Public } from "@crimfig/shared";

export class CreateCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(["websites", "individuals", "mobile_apps"], { each: true })
  channels?: string[];

  @IsNumber()
  @Min(5)
  budgetUsd: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  dailyBudgetUsd?: number;

  @IsOptional()
  @IsNumber()
  @Min(50)
  costPerImpressionCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(10)
  costPerClickCents?: number;

  @IsOptional()
  @IsIn(["banner", "card", "video", "interstitial"])
  format?: "banner" | "card" | "video" | "interstitial";

  @IsOptional()
  @IsIn(["cpm", "cpc"])
  pricingModel?: "cpm" | "cpc";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  targetCountries?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  targetStates?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  targetDevices?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(23, { each: true })
  targetHours?: number[];

  @IsOptional() @IsObject() schedule?: object;
  @IsOptional() @IsUUID() requestId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  frequencyCapPerDay?: number;

  @IsOptional()
  @IsIn(["global", "targeted"])
  geoMode?: "global" | "targeted";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  locations?: string[];
}

export class AddCreativeDto {
  @IsOptional()
  @IsUUID()
  adStackId?: string;

  @IsOptional()
  @IsIn(["text", "image", "video"])
  adType?: "text" | "image" | "video";

  @IsOptional()
  @IsString()
  @MaxLength(100)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bodyText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  ctaText?: string;

  @IsString()
  @MaxLength(2048)
  destinationUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  videoUrl?: string;

  @IsOptional()
  @IsIn(["banner", "card", "video", "interstitial"])
  adFormat?: "banner" | "card" | "video" | "interstitial";

  @IsOptional()
  @IsIn(["image", "gif", "video"])
  mediaFormat?: "image" | "gif" | "video";

  @IsOptional()
  @IsUUID()
  mediaAssetId?: string;
}

export class ReplaceCreativeDto {
  @IsOptional()
  @IsUUID()
  adStackId?: string;

  @IsOptional()
  @IsIn(["text", "image", "video"])
  adType?: "text" | "image" | "video";

  @IsOptional()
  @IsString()
  @MaxLength(100)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bodyText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  ctaText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  destinationUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  videoUrl?: string;

  @IsOptional()
  @IsIn(["banner", "card", "video", "interstitial"])
  adFormat?: "banner" | "card" | "video" | "interstitial";

  @IsOptional()
  @IsIn(["image", "gif", "video"])
  mediaFormat?: "image" | "gif" | "video";

  @IsOptional()
  @IsUUID()
  mediaAssetId?: string;
}

export class CreateStackDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;
}

export class UpdateStackDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(["inherit", "global", "targeted"])
  geoMode?: "inherit" | "global" | "targeted";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  locations?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  targetDevices?: string[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(23, { each: true })
  targetHours?: number[] | null;

  @IsOptional() @IsObject() schedule?: object;
}

@ApiTags("Campaigns")
@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Public()
  @Get("catalog")
  @ApiOperation({
    summary: "Browse active campaigns available for promoters to display",
  })
  @ApiQuery({ name: "category", required: false })
  async getCatalog(@Query("category") category?: string) {
    return {
      status: "success",
      data: await this.campaignsService.getPublicCatalog(category),
    };
  }

  @Get("creation-capabilities")
  @ApiOperation({
    summary: "Server-owned creative capabilities for the campaign wizard",
  })
  getCreationCapabilities() {
    return {
      status: "success",
      data: this.campaignsService.creationCapabilities(),
    };
  }

  @Get()
  @ApiOperation({
    summary: "List advertiser campaigns with optional status filter",
  })
  @ApiQuery({ name: "status", required: false })
  async getAdvertiserCampaigns(
    @Req() req: any,
    @Query("status") status?: string,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.getAdvertiserCampaigns(
        req.user.sub,
        status,
      ),
    };
  }

  @Post()
  @ApiOperation({ summary: "Create new ad campaign with its default ad stack" })
  async createCampaign(@Req() req: any, @Body() dto: CreateCampaignDto) {
    const campaign = await this.campaignsService.createCampaign({
      advertiserId: req.user.sub,
      title: dto.title,
      description: dto.description,
      category: dto.category,
      channels: dto.channels,
      budgetUsd: dto.budgetUsd,
      dailyBudgetUsd: dto.dailyBudgetUsd,
      costPerImpressionCents: dto.costPerImpressionCents,
      costPerClickCents: dto.costPerClickCents,
      pricingModel: dto.pricingModel,
      format: dto.format,
      targetCountries: dto.targetCountries,
      targetStates: dto.targetStates,
      targetDevices: dto.targetDevices,
      targetHours: dto.targetHours,
      schedule: dto.schedule,
      requestId: dto.requestId,
      frequencyCapPerDay: dto.frequencyCapPerDay,
      geoMode: dto.geoMode,
      locations: dto.locations,
    });
    return { status: "success", data: campaign };
  }

  @Get("creation-request/:requestId")
  async findCreationRequest(
    @Param("requestId") requestId: string,
    @Req() req: any,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(requestId))
      throw new (require("@nestjs/common").BadRequestException)(
        "Invalid request ID.",
      );
    return {
      status: "success",
      data: await this.campaignsService.findCreationRequest(
        req.user.sub,
        requestId,
      ),
    };
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get campaign details with ordered ad stacks and creatives",
  })
  async getCampaignDetails(@Param("id") id: string, @Req() req: any) {
    return {
      status: "success",
      data: await this.campaignsService.getCampaignDetails(id, req.user.sub),
    };
  }

  @Post(":id/ad-stacks")
  @ApiOperation({ summary: "Create an additional ad stack" })
  async createStack(
    @Param("id") campaignId: string,
    @Req() req: any,
    @Body() dto: CreateStackDto,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.createStack(
        campaignId,
        req.user.sub,
        dto.name,
      ),
    };
  }

  @Patch(":id/ad-stacks/:stackId")
  @ApiOperation({
    summary: "Rename a stack or update its non-financial overrides",
  })
  async updateStack(
    @Param("id") campaignId: string,
    @Param("stackId") stackId: string,
    @Req() req: any,
    @Body() dto: UpdateStackDto,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.updateStack(
        campaignId,
        stackId,
        req.user.sub,
        {
          name: dto.name,
          geoMode: dto.geoMode,
          locations: dto.locations,
          targetDevices: dto.targetDevices,
          targetHours: dto.targetHours,
          schedule: dto.schedule,
        },
      ),
    };
  }

  @Delete(":id/ad-stacks/:stackId")
  @ApiOperation({ summary: "Remove an additional ad stack and its draft ads" })
  async deleteStack(
    @Param("id") campaignId: string,
    @Param("stackId") stackId: string,
    @Req() req: any,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.deleteStack(
        campaignId,
        stackId,
        req.user.sub,
      ),
    };
  }

  @Post(":id/creatives")
  @ApiOperation({ summary: "Add a typed creative to an ad stack" })
  async addCreative(
    @Param("id") campaignId: string,
    @Req() req: any,
    @Body() dto: AddCreativeDto,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.addCreative(campaignId, req.user.sub, {
        adStackId: dto.adStackId,
        adType: dto.adType,
        headline: dto.headline,
        bodyText: dto.bodyText,
        ctaText: dto.ctaText,
        destinationUrl: dto.destinationUrl,
        imageUrl: dto.imageUrl,
        videoUrl: dto.videoUrl,
        adFormat: dto.adFormat,
        mediaFormat: dto.mediaFormat,
        mediaAssetId: dto.mediaAssetId,
      }),
    };
  }

  @Put("creatives/:id/replace")
  @ApiOperation({
    summary: "Replace or update a creative and re-submit it for review",
  })
  async replaceCreative(
    @Param("id") creativeId: string,
    @Req() req: any,
    @Body() dto: ReplaceCreativeDto,
  ) {
    return {
      status: "success",
      data: await this.campaignsService.replaceCreative(
        creativeId,
        req.user.sub,
        dto,
      ),
    };
  }

  @Post(":id/submit-review")
  @ApiOperation({
    summary: "Validate stacks and submit the campaign for moderation review",
  })
  async submitForReview(@Param("id") id: string, @Req() req: any) {
    return {
      status: "success",
      data: await this.campaignsService.submitForReview(id, req.user.sub),
    };
  }

  @Put(":id/status")
  @ApiOperation({ summary: "Update campaign status" })
  async updateStatus(
    @Param("id") id: string,
    @Req() req: any,
    @Body("status")
    status:
      | "active"
      | "paused"
      | "under_review"
      | "draft"
      | "rejected"
      | "suspended"
      | "trash",
  ) {
    return {
      status: "success",
      data: await this.campaignsService.updateStatus(id, req.user.sub, status),
    };
  }
}
