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
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsUrl,
  Min,
  Max,
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
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  destinationUrl?: string;

  @IsOptional()
  @IsIn(['image', 'text', 'video'])
  adType?: 'image' | 'text' | 'video';

  @IsOptional()
  @IsString()
  format?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl?: string;

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
  @IsString()
  format?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  imageUrl?: string;

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

  @Get('analytics')
  @ApiOperation({ summary: 'Get aggregated house ad performance breakdown' })
  async getHouseAnalytics() {
    const [serveTotals] = await this.db
      .select({
        totalServes: sql<number>`count(*)::int`,
      })
      .from(adsServes)
      .where(eq(adsServes.inventoryClass, 'house'));

    const [interactionTotals] = await this.db
      .select({
        totalClicks: sql<number>`count(*) filter (where ${adsInteractions.type} = 'click')::int`,
        totalRenders: sql<number>`count(*) filter (where ${adsInteractions.type} = 'render')::int`,
        totalImpressions: sql<number>`count(*) filter (where ${adsInteractions.type} = 'impression')::int`,
        totalViewable: sql<number>`count(*) filter (where ${adsInteractions.type} = 'viewable_impression')::int`,
      })
      .from(adsInteractions)
      .innerJoin(adsServes, eq(adsInteractions.serveId, adsServes.id))
      .where(eq(adsServes.inventoryClass, 'house'));

    // Per-creative attribution breakdown
    const creativeBreakdown = await this.db
      .select({
        houseCreativeId: adsServes.houseCreativeId,
        title: adsHouseCreatives.title,
        adType: adsHouseCreatives.adType,
        format: adsHouseCreatives.format,
        serves: sql<number>`count(distinct ${adsServes.id})::int`,
        clicks: sql<number>`count(distinct case when ${adsInteractions.type} = 'click' then ${adsInteractions.id} end)::int`,
      })
      .from(adsServes)
      .leftJoin(adsHouseCreatives, eq(adsServes.houseCreativeId, adsHouseCreatives.id))
      .leftJoin(adsInteractions, eq(adsInteractions.serveId, adsServes.id))
      .where(eq(adsServes.inventoryClass, 'house'))
      .groupBy(adsServes.houseCreativeId, adsHouseCreatives.title, adsHouseCreatives.adType, adsHouseCreatives.format);

    const totalServes = serveTotals?.totalServes || 0;
    const totalClicks = interactionTotals?.totalClicks || 0;
    const totalRenders = interactionTotals?.totalRenders || 0;
    const totalImpressions = interactionTotals?.totalImpressions || 0;
    const totalViewable = interactionTotals?.totalViewable || 0;

    return {
      status: 'success',
      data: {
        funnel: {
          serves: totalServes,
          renders: totalRenders,
          impressions: totalImpressions,
          viewableImpressions: totalViewable,
          clicks: totalClicks,
          ctr: totalImpressions > 0 ? Number((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : null,
          renderRate: totalServes > 0 ? Number((totalRenders / totalServes) * 100).toFixed(2) + '%' : null,
        },
        creatives: creativeBreakdown.map((row) => ({
          houseCreativeId: row.houseCreativeId,
          title: row.title || 'Default House Ad',
          adType: row.adType || 'image',
          format: row.format || 'banner',
          serves: row.serves,
          clicks: row.clicks,
          ctr: row.serves > 0 ? Number((row.clicks / row.serves) * 100).toFixed(2) + '%' : '0.00%',
        })),
        asOf: new Date().toISOString(),
      },
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all house creatives with analytics' })
  async listHouseCreatives() {
    const creatives = await this.db
      .select()
      .from(adsHouseCreatives)
      .where(eq(adsHouseCreatives.isArchived, false))
      .orderBy(desc(adsHouseCreatives.priority), desc(adsHouseCreatives.createdAt));

    // Aggregate house ad metrics (serves & clicks) using explicit relational joins
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
      .innerJoin(adsServes, eq(adsInteractions.serveId, adsServes.id))
      .where(and(
        eq(adsServes.inventoryClass, 'house'),
        eq(adsInteractions.type, 'click')
      ));

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
    if (dto.adType === 'image' && !dto.imageUrl) {
      throw new BadRequestException('Image creative requires imageUrl');
    }
    if (dto.adType === 'video' && !dto.videoUrl) {
      throw new BadRequestException('Video creative requires videoUrl');
    }

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

    const mergedAdType = dto.adType || existing.adType;
    const mergedImageUrl = dto.imageUrl !== undefined ? dto.imageUrl : existing.imageUrl;
    const mergedVideoUrl = dto.videoUrl !== undefined ? dto.videoUrl : existing.videoUrl;

    if (mergedAdType === 'image' && !mergedImageUrl) {
      throw new BadRequestException('Image creative requires imageUrl');
    }
    if (mergedAdType === 'video' && !mergedVideoUrl) {
      throw new BadRequestException('Video creative requires videoUrl');
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

