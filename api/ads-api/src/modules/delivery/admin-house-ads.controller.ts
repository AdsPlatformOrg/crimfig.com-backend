import { defaultHouseDestination, requireHouseDestination } from './house-click-policy';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Query,
  Inject,
  ParseUUIDPipe,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdsRoles } from '../security/ads-staff-grants';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsHouseCreatives, adsServes, adsInteractions } from '@crimfig/database/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsUrl,
  Min,
  Max,
} from 'class-validator';
import {
  isApprovedImagePreset,
  getImagePreset,
  findPresetByExactDimensions,
  APPROVED_IMAGE_PRESET_IDS,
} from '../uploads/image-ad-presets';

export class CreateHouseCreativeDto {
  @IsString()
  title: string;

  @IsString()
  headline: string;

  @IsString()
  bodyText: string;

  @IsOptional()
  @IsString()
  ctaText?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  destinationUrl?: string;

  @IsOptional()
  @IsIn(['image', 'text', 'video'])
  adType?: 'image' | 'text' | 'video';

  @IsOptional()
  @IsIn(['banner','square','interstitial','card','video','any','sidebar_sticky','in_content_mid','in_content_end'])
  format?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl?: string;

  @IsOptional() @IsUUID() imageAssetId?:string;
  @IsOptional() @IsUUID() videoAssetId?:string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(3840)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2160)
  height?: number;

  @IsOptional()
  @IsString()
  targetPreset?: string;

  @IsOptional()
  @IsInt()
  renditionWidth?: number;

  @IsOptional()
  @IsInt()
  renditionHeight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateHouseCreativeDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  headline?: string;

  @IsOptional()
  @IsString()
  bodyText?: string;

  @IsOptional()
  @IsString()
  ctaText?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  destinationUrl?: string;

  @IsOptional()
  @IsIn(['image', 'text', 'video'])
  adType?: 'image' | 'text' | 'video';

  @IsOptional()
  @IsIn(['banner','square','interstitial','card','video','any','sidebar_sticky','in_content_mid','in_content_end'])
  format?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl?: string;

  @IsOptional() @IsUUID() imageAssetId?:string;
  @IsOptional() @IsUUID() videoAssetId?:string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(3840)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2160)
  height?: number;

  @IsOptional()
  @IsString()
  targetPreset?: string;

  @IsOptional()
  @IsInt()
  renditionWidth?: number;

  @IsOptional()
  @IsInt()
  renditionHeight?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@ApiTags('Admin House Ads')
@AdsRoles('ads_admin', 'super_admin')
@Controller('admin/ads/house-creatives')
export class AdminHouseAdsController {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  private async validateAssets(dto:CreateHouseCreativeDto|UpdateHouseCreativeDto,actor:string){
    for(const [field,type]of [['imageAssetId','image'],['videoAssetId','video']] as const){const id=dto[field];if(!id)continue;const [asset]=await this.db.select().from(schema.adsMediaAssets).where(and(eq(schema.adsMediaAssets.id,id),eq(schema.adsMediaAssets.ownerId,actor),eq(schema.adsMediaAssets.status,'ready'))).limit(1);if(!asset||!asset.mimeType.startsWith(type+'/'))throw new BadRequestException('Uploaded media must be a ready asset owned by the acting administrator');const fieldUrl=type==='image'?'imageUrl':'videoUrl';const provided=dto[fieldUrl];if(!provided)throw new BadRequestException('Uploaded media URL is required');let path:string;try{path=new URL(provided).pathname;}catch{throw new BadRequestException('Invalid media URL');}if(path!==asset.cdnUrl)throw new BadRequestException('Uploaded media URL does not match asset');}
  }

  @Get()
  @ApiOperation({ summary: 'List all house creatives with analytics' })
  async listHouseCreatives(@Query() query:Record<string,string> = {}) {
    if(Object.values(query).some(value=>typeof value!=='string'))throw new BadRequestException('Catalog query values must be strings');
    const page=Number(query.page||1),limit=Number(query.limit||25);
    if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(limit)||limit<1||limit>100)throw new BadRequestException('Invalid pagination');
    const creatives = await this.db
      .select()
      .from(adsHouseCreatives)
      .where(eq(adsHouseCreatives.isArchived, false))
      .orderBy(desc(adsHouseCreatives.priority), desc(adsHouseCreatives.createdAt),desc(adsHouseCreatives.id)).limit(limit+1).offset((page-1)*limit);

    return { status: 'success', data: creatives.slice(0,limit), analytics: null, meta:{page,limit,hasNext:creatives.length>limit} };
  }

  private resolvePresetFields(
    dto: Pick<CreateHouseCreativeDto | UpdateHouseCreativeDto, 'targetPreset' | 'renditionWidth' | 'renditionHeight' | 'width' | 'height'>,
    existing?: { targetPreset: string | null; renditionWidth: number | null; renditionHeight: number | null; width: number | null; height: number | null },
  ) {
    const dimensionsChanged =
      !!existing &&
      ((dto.width !== undefined && dto.width !== existing.width) ||
        (dto.height !== undefined && dto.height !== existing.height) ||
        (dto.renditionWidth !== undefined && dto.renditionWidth !== existing.renditionWidth) ||
        (dto.renditionHeight !== undefined && dto.renditionHeight !== existing.renditionHeight));

    const targetPresetExplicitlyUpdated =
      dto.targetPreset !== undefined && (!existing || dto.targetPreset !== existing.targetPreset);

    if (targetPresetExplicitlyUpdated && dto.targetPreset) {
      if (!isApprovedImagePreset(dto.targetPreset)) {
        throw new BadRequestException(`Target preset must be one of: ${APPROVED_IMAGE_PRESET_IDS.join(', ')}`);
      }
      const preset = getImagePreset(dto.targetPreset);
      if (preset) {
        return {
          targetPreset: preset.id,
          renditionWidth: preset.width,
          renditionHeight: preset.height,
          width: preset.width,
          height: preset.height,
        };
      }
    }

    const nextWidth = dimensionsChanged
      ? (dto.width ?? dto.renditionWidth ?? existing?.width ?? existing?.renditionWidth ?? null)
      : (dto.renditionWidth ?? dto.width ?? existing?.renditionWidth ?? existing?.width ?? null);
    const nextHeight = dimensionsChanged
      ? (dto.height ?? dto.renditionHeight ?? existing?.height ?? existing?.renditionHeight ?? null)
      : (dto.renditionHeight ?? dto.height ?? existing?.renditionHeight ?? existing?.height ?? null);

    if (nextWidth && nextHeight) {
      const match = findPresetByExactDimensions(nextWidth, nextHeight);
      return {
        targetPreset: match ? match.id : null,
        renditionWidth: nextWidth,
        renditionHeight: nextHeight,
        width: nextWidth,
        height: nextHeight,
      };
    }

    return {
      targetPreset: dimensionsChanged ? null : (dto.targetPreset ?? existing?.targetPreset ?? null),
      renditionWidth: nextWidth,
      renditionHeight: nextHeight,
      width: nextWidth,
      height: nextHeight,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new house ad creative' })
  async createHouseCreative(@Body() dto: CreateHouseCreativeDto, @Req() req: any) {
    if (dto.destinationUrl !== undefined) requireHouseDestination(dto.destinationUrl);
    await this.validateAssets(dto,req.user.sub);
    if ((dto.adType || 'image') === 'image' && !dto.imageUrl) {
      throw new BadRequestException('Image creative requires imageUrl');
    }
    if (dto.adType === 'video' && !dto.videoUrl) {
      throw new BadRequestException('Video creative requires videoUrl');
    }

    // PLAN-0067 / PLAN-0163: Validate target preset if provided or resolve from dimensions
    const { targetPreset, renditionWidth, renditionHeight, width, height } = this.resolvePresetFields(dto);

    const [created] = await this.db
      .insert(adsHouseCreatives)
      .values({
        title: dto.title,
        headline: dto.headline,
        bodyText: dto.bodyText,
        ctaText: dto.ctaText || 'Start Advertising',
        destinationUrl: dto.destinationUrl === undefined ? defaultHouseDestination() : requireHouseDestination(dto.destinationUrl),
        adType: dto.adType || 'image',
        format: dto.format || 'banner',
        imageAssetId:dto.imageAssetId||null,
        videoAssetId:dto.videoAssetId||null,
        imageUrl: dto.imageUrl || null,
        videoUrl: dto.videoUrl || null,
        width: width || (dto.adType === 'image' ? 300 : 728),
        height: height || (dto.adType === 'image' ? 250 : 90),
        targetPreset,
        renditionWidth,
        renditionHeight,
        priority: dto.priority !== undefined ? dto.priority : 10,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
        createdBy: req.user?.id || req.user?.sub || null,
      })
      .returning();

    return {
      status: 'success',
      message: 'House ad creative created successfully',
      data: created,
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update or toggle house ad creative' })
  async updateHouseCreative(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHouseCreativeDto,
    @Req() req:any,
  ) {
    if (dto.destinationUrl !== undefined) requireHouseDestination(dto.destinationUrl);
    await this.validateAssets(dto,req.user.sub);
    const [existing] = await this.db
      .select()
      .from(adsHouseCreatives)
      .where(eq(adsHouseCreatives.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException('House creative not found');
    }

    const mergedAdType = dto.adType || existing.adType;
    const mergedImageUrl = dto.imageUrl !== undefined ? dto.imageUrl : existing.imageUrl;
    const mergedVideoUrl = dto.videoUrl !== undefined ? dto.videoUrl : existing.videoUrl;

    if (mergedAdType === 'image' && !mergedImageUrl) {
      throw new BadRequestException('Image creative requires imageUrl');
    }
    if (mergedAdType === 'video' && !mergedVideoUrl) {
      throw new BadRequestException('Video creative requires videoUrl');
    }

    const resolved = this.resolvePresetFields(dto, existing);

    const [updated] = await this.db
      .update(adsHouseCreatives)
      .set({
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.headline !== undefined ? { headline: dto.headline } : {}),
        ...(dto.bodyText !== undefined ? { bodyText: dto.bodyText } : {}),
        ...(dto.ctaText !== undefined ? { ctaText: dto.ctaText } : {}),
        ...(dto.destinationUrl !== undefined ? { destinationUrl: requireHouseDestination(dto.destinationUrl) } : {}),
        ...(dto.adType !== undefined ? { adType: dto.adType } : {}),
        ...(dto.format !== undefined ? { format: dto.format } : {}),
        ...(dto.imageAssetId!==undefined?{imageAssetId:dto.imageAssetId}:{}),
        ...(dto.videoAssetId!==undefined?{videoAssetId:dto.videoAssetId}:{}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl, imageAssetId:dto.imageAssetId||null } : {}),
        ...(dto.videoUrl !== undefined ? { videoUrl: dto.videoUrl, videoAssetId:dto.videoAssetId||null } : {}),
        targetPreset: resolved.targetPreset,
        renditionWidth: resolved.renditionWidth,
        renditionHeight: resolved.renditionHeight,
        ...(resolved.width != null ? { width: resolved.width } : {}),
        ...(resolved.height != null ? { height: resolved.height } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(adsHouseCreatives.id, id))
      .returning();

    return {
      status: 'success',
      message: 'House ad creative updated successfully',
      data: updated,
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive a house ad creative without breaking attribution' })
  async deleteHouseCreative(@Param('id', ParseUUIDPipe) id: string) {
    const [existing] = await this.db
      .select()
      .from(adsHouseCreatives)
      .where(eq(adsHouseCreatives.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException('House creative not found');
    }

    // Soft-archive to preserve past attribution and analytics integrity
    const [archived] = await this.db
      .update(adsHouseCreatives)
      .set({
        isArchived: true,
        isActive: false,
        archivedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsHouseCreatives.id, id))
      .returning();

    return {
      status: 'success',
      message: 'House ad creative archived successfully',
      data: { id: archived.id, isArchived: true },
    };
  }
}

