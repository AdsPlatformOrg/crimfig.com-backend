import { AdsRoles } from '../security/ads-staff-grants';
import { Public } from '@crimfig/shared';
import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  Res,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { UploadsService } from './uploads.service';
import { IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { ADS_MEDIA_UPLOAD_SETTINGS } from '../../config/ads-settings.constants';

export class PresignUploadDto {
  @IsString()
  fileName: string;

  @IsString()
  contentType: string;

  @IsNumber()
  @Min(1)
  contentLength: number;

  @IsOptional()
  @IsString()
  sha256?: string;
}

export class CompleteUploadDto {
  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;

  @IsOptional()
  @IsNumber()
  durationSeconds?: number;

  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}

@ApiTags('Uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get current ads media upload settings and file restrictions' })
  getSettings() {
    return { status: 'success', data: this.uploadsService.getSettings() };
  }

  @Post('direct')
  @ApiOperation({ summary: 'Upload file directly to Firebase bucket (Images <= 750KB, Videos <= 20MB, flat photo-/file- naming)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: ADS_MEDIA_UPLOAD_SETTINGS.limits.videoMaxBytes, // Outer Multer boundary (20MB)
      },
    }),
  )
  async uploadDirect(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded in form field "file"');
    }
    const ownerId = req.user.sub;
    const result = await this.uploadsService.uploadDirect({
      ownerId,
      file,
    });
    return { status: 'success', data: result };
  }

  private parseRange(header: string | undefined): { start: number; end?: number } | undefined {
    if (!header) return undefined;
    const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : undefined;
    if (!Number.isSafeInteger(start) || (end !== undefined && !Number.isSafeInteger(end))) return undefined;
    return { start, end };
  }

  private async sendMedia(
    req: Request,
    res: Response,
    storageKey: string,
    cacheControl: string,
    ownerId?: string,
    staffReview = false,
  ) {
    const range = this.parseRange(req.headers.range);
    const result = range
      ? await this.uploadsService.getMediaStream(storageKey, ownerId, staffReview, range)
      : ownerId
        ? await this.uploadsService.getMediaStream(storageKey, ownerId)
        : staffReview
          ? await this.uploadsService.getMediaStream(storageKey, undefined, true)
          : await this.uploadsService.getMediaStream(storageKey);
    if ('rangeInvalid' in result) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${result.totalSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.end();
      return;
    }
    res.status(result.partial ? 206 : 200);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', String(result.contentLength));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', cacheControl);
    if (result.partial) res.setHeader('Content-Range', result.contentRange);
    result.stream.pipe(res);
  }

  @Public()
  @Get('media/:storageKey')
  @ApiOperation({ summary: 'Stream approved active public ad media with byte-range support' })
  async getMedia(
    @Param('storageKey') storageKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.sendMedia(req, res, storageKey, 'public, max-age=31536000, immutable');
  }

  @Get('private-media/:storageKey')
  @ApiOperation({ summary: 'Authenticated owner preview of a ready media asset' })
  async previewMedia(@Param('storageKey') storageKey: string, @Req() req: any, @Res() res: Response) {
    await this.sendMedia(req, res, storageKey, 'no-store', req.user.sub);
  }

  @AdsRoles('ads_reviewer', 'ads_manager', 'ads_admin', 'ads_support', 'super_admin')
  @Get('review-media/:storageKey')
  @ApiOperation({ summary: 'Ready asset preview for explicitly assigned moderation staff' })
  async reviewMedia(@Param('storageKey') storageKey: string, @Req() req: Request, @Res() res: Response) {
    await this.sendMedia(req, res, storageKey, 'no-store', undefined, true);
  }

  @Post('presign')
  @ApiOperation({ summary: 'Obtain presigned upload URL for direct Firebase bucket asset upload' })
  async presign(@Body() dto: PresignUploadDto, @Req() req: any) {
    const ownerId = req.user.sub;
    const result = await this.uploadsService.presign({
      ownerId,
      fileName: dto.fileName,
      contentType: dto.contentType,
      contentLength: dto.contentLength,
      sha256: dto.sha256,
    });
    return { status: 'success', data: result };
  }

  @Post(':assetId/complete')
  @ApiOperation({ summary: 'Complete asset upload and mark ready for creative binding' })
  async complete(
    @Param('assetId') assetId: string,
    @Body() dto: CompleteUploadDto,
    @Req() req: any,
  ) {
    const ownerId = req.user.sub;
    const result = await this.uploadsService.complete({
      assetId,
      ownerId,
      width: dto.width,
      height: dto.height,
      durationSeconds: dto.durationSeconds,
      thumbnailUrl: dto.thumbnailUrl,
    });
    return { status: 'success', data: result };
  }

  @Delete(':assetId')
  @ApiOperation({ summary: 'Delete unattached media asset' })
  async deleteAsset(@Param('assetId') assetId: string, @Req() req: any) {
    const ownerId = req.user.sub;
    const result = await this.uploadsService.deleteAsset(assetId, ownerId);
    return { status: 'success', data: result };
  }
}
