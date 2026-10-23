import { Injectable, Logger, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsMediaAssets } from '@crimfig/database/schema';
import { eq, and, or } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as path from 'path';
import { FirebaseStorageService } from './firebase-storage.service';
import { ADS_MEDIA_UPLOAD_SETTINGS } from '../../config/ads-settings.constants';

export interface PresignRequest {
  ownerId: string;
  fileName: string;
  contentType: string;
  contentLength: number;
  sha256?: string;
}

export interface DirectUploadParams {
  ownerId: string;
  file: Express.Multer.File;
}

export interface CompleteUploadRequest {
  assetId: string;
  ownerId: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly configService: ConfigService,
    private readonly firebaseStorageService: FirebaseStorageService,
  ) {}

  /**
   * Returns current upload settings and limits (for client consumption)
   */
  getSettings() {
    return ADS_MEDIA_UPLOAD_SETTINGS;
  }

  /**
   * Generates a flat bucket key without subfolders using "photo-" or "file-" prefix.
   */
  private generateStorageKey(mimeType: string, ownerId: string, ext: string, sha256: string): string {
    const isImage = ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.includes(mimeType);
    const prefix = isImage
      ? ADS_MEDIA_UPLOAD_SETTINGS.storage.imagePrefix
      : ADS_MEDIA_UPLOAD_SETTINGS.storage.filePrefix;
    // Format: photo-<timestamp>-<hash>.<ext> or file-<timestamp>-<hash>.<ext>
    return `${prefix}${Date.now()}-${sha256.substring(0, 16)}.${ext}`;
  }

  /**
   * Fast, zero-dependency binary buffer parser to detect if a GIF is animated.
   * A GIF is animated if it contains more than one Graphic Control Extension block (0x21 0xF9 0x04)
   * or a Netscape Application Extension block (NETSCAPE2.0).
   */
   private isAnimatedGif(buffer: Buffer): boolean {
     if (!buffer || buffer.length < 14) return false;
     // Check GIF magic header ('GIF87a' or 'GIF89a')
     const magic = buffer.toString('ascii', 0, 6);
     if (magic !== 'GIF87a' && magic !== 'GIF89a') return false;

     let framesCount = 0;
     for (let i = 0; i < buffer.length - 4; i++) {
       // Look for Graphic Control Extension block: 0x21 0xF9 0x04
       if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9 && buffer[i + 2] === 0x04) {
         framesCount++;
         if (framesCount > 1) {
           return true;
         }
       }
     }

     // Secondary check: look for Netscape application extension (looping metadata)
     if (buffer.indexOf('NETSCAPE2.0') !== -1 || buffer.indexOf('ANIMEXTS1.0') !== -1) {
       return true;
     }

     return false;
   }

  /**
   * Validates MIME type and strict file size restrictions.
   * Accurately detects animated GIFs and classifies them as videos (20MB limit).
   * Static single-frame GIFs remain allowed as photo creatives (750KB limit).
   * Rejects immediately if not passing. No server-side compression/optimization.
   */
  private validateRestrictions(
    mimeType: string,
    byteLength: number,
    options?: { buffer?: Buffer; targetSlot?: 'photo' | 'video' },
  ): { resolvedType: 'image' | 'video'; isAnimatedGif: boolean } {
    let isImage = ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.includes(mimeType);
    let isVideo = ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.videos.includes(mimeType);
    let isAnimated = false;

    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `Invalid file type '${mimeType}'. Allowed formats: ` +
          `Images (${ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.join(', ')}), ` +
          `Videos (${ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.videos.join(', ')}).`,
      );
    }

    // Inspect GIF animation if buffer is available
    if (mimeType === 'image/gif' && options?.buffer) {
      isAnimated = this.isAnimatedGif(options.buffer);
      if (isAnimated) {
        // Classify animated GIF as video
        isImage = false;
        isVideo = true;

        if (options?.targetSlot === 'photo') {
          throw new BadRequestException(
            'Animated GIFs are classified as videos on the CrimFig Ads platform. ' +
              'Please select the Video ad format (up to 20MB) to upload animated GIFs, or upload a static image (JPG/PNG/WEBP/AVIF/Static GIF up to 750KB).',
          );
        }
      }
    }

    if (isImage && byteLength > ADS_MEDIA_UPLOAD_SETTINGS.limits.imageMaxBytes) {
      const maxKb = Math.round(ADS_MEDIA_UPLOAD_SETTINGS.limits.imageMaxBytes / 1024);
      const actualKb = (byteLength / 1024).toFixed(1);
      throw new BadRequestException(
        `Image size ${actualKb}KB exceeds maximum limit of ${maxKb}KB (750KB). Server optimization is disabled. Please resize or compress your image locally before uploading.`,
      );
    }

    if (isVideo && byteLength > ADS_MEDIA_UPLOAD_SETTINGS.limits.videoMaxBytes) {
      const maxMb = Math.round(ADS_MEDIA_UPLOAD_SETTINGS.limits.videoMaxBytes / (1024 * 1024));
      const actualMb = (byteLength / (1024 * 1024)).toFixed(1);
      const label = isAnimated ? 'Animated GIF' : 'Video';
      throw new BadRequestException(
        `${label} size ${actualMb}MB exceeds maximum limit of ${maxMb}MB (20MB). Server optimization is disabled. Please encode or compress your media locally before uploading.`,
      );
    }

    return {
      resolvedType: isVideo ? 'video' : 'image',
      isAnimatedGif: isAnimated,
    };
  }

  /**
   * Direct binary upload to Firebase Storage bucket.
   * Enforces flat naming ("photo-..." or "file-...") without subfolders.
   * Assumes private storage: returns CrimFig server proxy URL (/api/v1/uploads/media/:storageKey).
   */
  async uploadDirect(params: DirectUploadParams) {
    const { file, ownerId } = params;
    if (!file || !file.buffer) {
      throw new BadRequestException('No file buffer provided for upload.');
    }

    // 1. Strict validation (No server-side compression) with GIF animation detection
    const { resolvedType, isAnimatedGif } = this.validateRestrictions(file.mimetype, file.size, {
      buffer: file.buffer,
    });

    // 2. Hash calculation and flat storage key generation
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const ext = path.extname(file.originalname).replace('.', '') || 'bin';
    // If it is an animated GIF, use the video/file prefix ("file-") instead of "photo-"
    const prefix = resolvedType === 'video'
      ? ADS_MEDIA_UPLOAD_SETTINGS.storage.videoPrefix
      : ADS_MEDIA_UPLOAD_SETTINGS.storage.imagePrefix;
    const storageKey = `${prefix}${Date.now()}-${sha256.substring(0, 16)}.${ext}`;

    const bucket = this.firebaseStorageService.getBucket();

    if (bucket) {
      const firebaseFile = bucket.file(storageKey);
      await firebaseFile.save(file.buffer, {
        metadata: {
          contentType: file.mimetype,
          metadata: {
            ownerId,
            originalName: file.originalname,
            sha256,
            isPrivate: 'true',
          },
        },
      });
    } else {
      this.logger.warn(`Firebase bucket not connected; saved mock private asset record: ${storageKey}`);
    }

    // Server-managed private access URL
    const cdnUrl = `/api/v1/uploads/media/${storageKey}`;

    // 3. Persist asset in ads_media_assets
    const [asset] = await this.db
      .insert(adsMediaAssets)
      .values({
        ownerId,
        storageKey,
        cdnUrl,
        mimeType: file.mimetype,
        bytes: file.size,
        sha256,
        status: 'ready',
      })
      .returning();

    return {
      assetId: asset.id,
      storageKey: asset.storageKey,
      cdnUrl: asset.cdnUrl,
      bytes: asset.bytes,
      mimeType: asset.mimeType,
      status: asset.status,
    };
  }

  /**
   * Generates a signed upload URL for direct client-to-bucket upload to Firebase
   */
  async presign(params: PresignRequest) {
    // 1. Strict size and MIME restriction validation
    this.validateRestrictions(params.contentType, params.contentLength);

    const sha256 = params.sha256 || crypto.randomBytes(32).toString('hex');
    const ext = params.fileName.split('.').pop() || 'bin';
    const storageKey = this.generateStorageKey(params.contentType, params.ownerId, ext, sha256);

    const bucket = this.firebaseStorageService.getBucket();
    let uploadUrl = '';
    const expiresAt = new Date(
      Date.now() + ADS_MEDIA_UPLOAD_SETTINGS.storage.signedUrlTtlMinutes * 60 * 1000,
    ).toISOString();

    if (bucket) {
      const fileRef = bucket.file(storageKey);
      const [signedUrl] = await fileRef.getSignedUrl({
        action: 'write',
        expires: Date.now() + ADS_MEDIA_UPLOAD_SETTINGS.storage.signedUrlTtlMinutes * 60 * 1000,
        contentType: params.contentType,
      });
      uploadUrl = signedUrl;
    } else {
      uploadUrl = `https://storage.googleapis.com/crimfig-mock/${storageKey}?mock=signed`;
    }

    const cdnUrl = `/api/v1/uploads/media/${storageKey}`;

    // Insert pending media asset record
    const [asset] = await this.db
      .insert(adsMediaAssets)
      .values({
        ownerId: params.ownerId,
        storageKey,
        cdnUrl,
        mimeType: params.contentType,
        bytes: params.contentLength,
        sha256,
        status: 'pending',
      })
      .returning();

    return {
      assetId: asset.id,
      storageKey,
      cdnUrl,
      uploadUrl,
      expiresAt,
    };
  }

  /**
   * Streams a private file securely from Firebase Storage bucket
   */
  async getMediaStream(storageKey: string, ownerId?: string, staffReview = false) {
    // Validate storageKey format to prevent directory traversal
    if (storageKey.includes('/') || storageKey.includes('\\') || storageKey.includes('..')) {
      throw new BadRequestException('Invalid media key format. Subdirectories not permitted.');
    }

    const [asset] = await this.db.select().from(adsMediaAssets).where(and(
      eq(adsMediaAssets.storageKey, storageKey), eq(adsMediaAssets.status, 'ready'),
      ...(ownerId ? [eq(adsMediaAssets.ownerId, ownerId)] : []),
    )).limit(1);
    if (!asset) throw new NotFoundException('Media asset not found');
    if (!ownerId && !staffReview) {
      const [approved] = await this.db.select({ id: schema.adsCreatives.id }).from(schema.adsCreatives)
        .innerJoin(schema.adsCampaigns, eq(schema.adsCreatives.campaignId, schema.adsCampaigns.id))
        .where(and(
          eq(schema.adsCampaigns.advertiserId, asset.ownerId),
          eq(schema.adsCampaigns.status, 'active'), eq(schema.adsCampaigns.moderationStatus, 'approved'),
          eq(schema.adsCreatives.status, 'active'), eq(schema.adsCreatives.reviewStatus, 'approved'),
          or(eq(schema.adsCreatives.imageUrl, asset.cdnUrl), eq(schema.adsCreatives.videoUrl, asset.cdnUrl)),
        )).limit(1);
      if (!approved) throw new NotFoundException('Public media asset not found');
    }
    const bucket = this.firebaseStorageService.getBucket();
    if (!bucket) {
      throw new NotFoundException('Storage bucket not initialized');
    }

    const fileRef = bucket.file(storageKey);
    const [exists] = await fileRef.exists();
    if (!exists) {
      throw new NotFoundException(`Media asset '${storageKey}' not found`);
    }

    const [metadata] = await fileRef.getMetadata();
    const stream = fileRef.createReadStream();

    return {
      stream,
      contentType: (metadata.contentType as string) || 'application/octet-stream',
      contentLength: metadata.size,
    };
  }

  /**
   * Finalizes an uploaded asset and marks it ready for creative binding
   */
  async complete(params: CompleteUploadRequest) {
    const [asset] = await this.db
      .select()
      .from(adsMediaAssets)
      .where(and(eq(adsMediaAssets.id, params.assetId), eq(adsMediaAssets.ownerId, params.ownerId)))
      .limit(1);

    if (!asset) {
      throw new NotFoundException('Media asset not found or unauthorized');
    }

    const [updated] = await this.db
      .update(adsMediaAssets)
      .set({
        status: 'ready',
        width: params.width || asset.width,
        height: params.height || asset.height,
        durationSeconds: params.durationSeconds || asset.durationSeconds,
        thumbnailUrl: params.thumbnailUrl || asset.thumbnailUrl,
        updatedAt: new Date(),
      })
      .where(eq(adsMediaAssets.id, params.assetId))
      .returning();

    return updated;
  }

  /**
   * Deletes an unattached asset
   */
  async deleteAsset(assetId: string, ownerId: string) {
    const [asset] = await this.db
      .select()
      .from(adsMediaAssets)
      .where(and(eq(adsMediaAssets.id, assetId), eq(adsMediaAssets.ownerId, ownerId)))
      .limit(1);

    if (!asset) {
      throw new NotFoundException('Media asset not found or unauthorized');
    }

    // If bucket is active, remove from Firebase storage
    try {
      const bucket = this.firebaseStorageService.getBucket();
      if (bucket && asset.storageKey) {
        await bucket.file(asset.storageKey).delete({ ignoreNotFound: true });
      }
    } catch (err: any) {
      this.logger.warn(`Could not delete file from Firebase bucket: ${err.message}`);
    }

    const [deleted] = await this.db
      .update(adsMediaAssets)
      .set({
        status: 'deleted',
        updatedAt: new Date(),
      })
      .where(eq(adsMediaAssets.id, assetId))
      .returning();

    return deleted;
  }
}
