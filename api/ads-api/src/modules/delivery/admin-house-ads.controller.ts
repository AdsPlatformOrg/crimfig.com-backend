import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Inject,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AdsRoles } from '../security/ads-staff-grants';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsHouseCreatives, adsServes, adsInteractions } from '@crimfig/database/schema';
import { eq, desc, sql } from 'drizzle-orm';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsUrl,
} from 'class-validator';

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
  @IsString()
  destinationUrl?: string;

  @IsOptional()
  @IsIn(['image', 'text', 'video'])
  adType?: 'image' | 'text' | 'video';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  width?: number;

  @IsOptional()
  @IsInt()
  height?: number;

  @IsOptional()
  @IsInt()
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
  @IsString()
  destinationUrl?: string;

  @IsOptional()
  @IsIn(['image', 'text', 'video'])
  adType?: 'image' | 'text' | 'video';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  width?: number;

  @IsOptional()
  @IsInt()
  height?: number;

  @IsOptional()
  @IsInt()
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

  @Get()
  @ApiOperation({ summary: 'List all house creatives with analytics' })
  async listHouseCreatives() {
    const creatives = await this.db
      .select()
      .from(adsHouseCreatives)
      .orderBy(desc(adsHouseCreatives.priority), desc(adsHouseCreatives.createdAt));

    // Aggregate house ad metrics (serves & clicks)
    const [serveStats] = await this.db
      .select({
        totalServes: sql<number>`count(*)::int`,
      })
      .from(adsServes)
      .where(eq(adsServes.inventoryClass, 'house'));

    const [clickStats] = await this.db
      .select({
        totalClicks: sql<number>`count(*)::int`,
      })
      .from(adsInteractions)
      .where(sql`type = 'click' AND imp_token LIKE '%00000000-0000-4000-8000-00000000cf01%'`);

    return {
      status: 'success',
      data: creatives,
      analytics: {
        totalHouseServes: serveStats?.totalServes || 0,
        totalHouseClicks: clickStats?.totalClicks || 0,
        ctr:
          serveStats?.totalServes && serveStats.totalServes > 0
            ? Number(((clickStats?.totalClicks || 0) / serveStats.totalServes) * 100).toFixed(2) + '%'
            : '0.00%',
      },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new house ad creative' })
  async createHouseCreative(@Body() dto: CreateHouseCreativeDto, @Req() req: any) {
    const [created] = await this.db
      .insert(adsHouseCreatives)
      .values({
        title: dto.title,
        headline: dto.headline,
        bodyText: dto.bodyText,
        ctaText: dto.ctaText || 'Start Advertising',
        destinationUrl: dto.destinationUrl || 'https://ads.crimfig.com',
        adType: dto.adType || 'image',
        format: dto.format || 'banner',
        imageUrl: dto.imageUrl || null,
        videoUrl: dto.videoUrl || null,
        width: dto.width || (dto.adType === 'image' ? 1024 : 728),
        height: dto.height || (dto.adType === 'image' ? 682 : 90),
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
  ) {
    const [existing] = await this.db
      .select()
      .from(adsHouseCreatives)
      .where(eq(adsHouseCreatives.id, id))
      .limit(1);

    if (!existing) {
      throw new NotFoundException('House creative not found');
    }

    const [updated] = await this.db
      .update(adsHouseCreatives)
      .set({
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.headline !== undefined ? { headline: dto.headline } : {}),
        ...(dto.bodyText !== undefined ? { bodyText: dto.bodyText } : {}),
        ...(dto.ctaText !== undefined ? { ctaText: dto.ctaText } : {}),
        ...(dto.destinationUrl !== undefined ? { destinationUrl: dto.destinationUrl } : {}),
        ...(dto.adType !== undefined ? { adType: dto.adType } : {}),
        ...(dto.format !== undefined ? { format: dto.format } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
        ...(dto.videoUrl !== undefined ? { videoUrl: dto.videoUrl } : {}),
        ...(dto.width !== undefined ? { width: dto.width } : {}),
        ...(dto.height !== undefined ? { height: dto.height } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
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
  @ApiOperation({ summary: 'Delete a house ad creative' })
  async deleteHouseCreative(@Param('id', ParseUUIDPipe) id: string) {
    const [deleted] = await this.db
      .delete(adsHouseCreatives)
      .where(eq(adsHouseCreatives.id, id))
      .returning();

    if (!deleted) {
      throw new NotFoundException('House creative not found');
    }

    return {
      status: 'success',
      message: 'House ad creative deleted successfully',
      data: { id: deleted.id },
    };
  }
}

