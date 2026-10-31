import {
  validatePreparedImages,
  validatePreparationDescriptor,
  IMAGE_PROFILES,
  imageSpecsView,
} from "./prepared-image";
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  Inject,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DATABASE_TOKEN } from "../database/database.module";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@crimfig/database/schema";
import { adsMediaAssets } from "@crimfig/database/schema";
import { eq, and, or, inArray } from "drizzle-orm";
import * as crypto from "crypto";
import * as path from "path";
import { FirebaseStorageService } from "./firebase-storage.service";
import { MediaStorageRouter } from "./media-storage-router.service";
import { adsMediaAssetLocations } from "@crimfig/database/schema";
import { ADS_MEDIA_UPLOAD_SETTINGS } from "../../config/ads-settings.constants";

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
    private readonly storageRouter: MediaStorageRouter,
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
  private generateStorageKey(
    mimeType: string,
    ownerId: string,
    ext: string,
    sha256: string,
  ): string {
    const isImage =
      ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.includes(mimeType);
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
    const magic = buffer.toString("ascii", 0, 6);
    if (magic !== "GIF87a" && magic !== "GIF89a") return false;

    let framesCount = 0;
    for (let i = 0; i < buffer.length - 4; i++) {
      // Look for Graphic Control Extension block: 0x21 0xF9 0x04
      if (
        buffer[i] === 0x21 &&
        buffer[i + 1] === 0xf9 &&
        buffer[i + 2] === 0x04
      ) {
        framesCount++;
        if (framesCount > 1) {
          return true;
        }
      }
    }

    // Secondary check: look for Netscape application extension (looping metadata)
    if (
      buffer.indexOf("NETSCAPE2.0") !== -1 ||
      buffer.indexOf("ANIMEXTS1.0") !== -1
    ) {
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
    options?: { buffer?: Buffer; targetSlot?: "photo" | "video" },
  ): { resolvedType: "image" | "video"; isAnimatedGif: boolean } {
    let isImage =
      ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.includes(mimeType);
    let isVideo =
      ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.videos.includes(mimeType);
    let isAnimated = false;

    if (!isImage && !isVideo) {
      throw new BadRequestException(
        `Invalid file type '${mimeType}'. Allowed formats: ` +
          `Images (${ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.images.join(", ")}), ` +
          `Videos (${ADS_MEDIA_UPLOAD_SETTINGS.allowedMimes.videos.join(", ")}).`,
      );
    }

    // Inspect GIF animation if buffer is available
    if (mimeType === "image/gif" && options?.buffer) {
      isAnimated = this.isAnimatedGif(options.buffer);
      if (isAnimated) {
        // Classify animated GIF as video
        isImage = false;
        isVideo = true;

        if (options?.targetSlot === "photo") {
          throw new BadRequestException(
            "Animated GIFs are classified as videos on the CrimFig Ads platform. " +
              "Please select the Video ad format (up to 20MB) to upload animated GIFs, or upload a static image (JPG/PNG/WEBP/AVIF/Static GIF up to 750KB).",
          );
        }
      }
    }

    if (
      isImage &&
      byteLength > ADS_MEDIA_UPLOAD_SETTINGS.limits.imageMaxBytes
    ) {
      const maxKb = Math.round(
        ADS_MEDIA_UPLOAD_SETTINGS.limits.imageMaxBytes / 1024,
      );
      const actualKb = (byteLength / 1024).toFixed(1);
      throw new BadRequestException(
        `Image size ${actualKb}KB exceeds maximum limit of ${maxKb}KB (750KB). Server optimization is disabled. Please resize or compress your image locally before uploading.`,
      );
    }

    if (
      isVideo &&
      byteLength > ADS_MEDIA_UPLOAD_SETTINGS.limits.videoMaxBytes
    ) {
      const maxMb = Math.round(
        ADS_MEDIA_UPLOAD_SETTINGS.limits.videoMaxBytes / (1024 * 1024),
      );
      const actualMb = (byteLength / (1024 * 1024)).toFixed(1);
      const label = isAnimated ? "Animated GIF" : "Video";
      throw new BadRequestException(
        `${label} size ${actualMb}MB exceeds maximum limit of ${maxMb}MB (20MB). Server optimization is disabled. Please encode or compress your media locally before uploading.`,
      );
    }

    return {
      resolvedType: isVideo ? "video" : "image",
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
      throw new BadRequestException("No file buffer provided for upload.");
    }

    // 1. Strict validation (No server-side compression) with GIF animation detection
    const { resolvedType, isAnimatedGif } = this.validateRestrictions(
      file.mimetype,
      file.size,
      {
        buffer: file.buffer,
      },
    );

    // 2. Hash calculation and flat storage key generation
    const sha256 = crypto
      .createHash("sha256")
      .update(file.buffer)
      .digest("hex");
    const ext = path.extname(file.originalname).replace(".", "") || "bin";
    // If it is an animated GIF, use the video/file prefix ("file-") instead of "photo-"
    const prefix =
      resolvedType === "video"
        ? ADS_MEDIA_UPLOAD_SETTINGS.storage.videoPrefix
        : ADS_MEDIA_UPLOAD_SETTINGS.storage.imagePrefix;
    const storageKey = `${prefix}${Date.now()}-${sha256.substring(0, 16)}.${ext}`;

    if (!this.storageRouter.isConfigured()) {
      throw new ServiceUnavailableException(
        "Media storage is unavailable. Your file was not uploaded; please try again later.",
      );
    }

    await this.storageRouter.putObject({
      key: storageKey,
      body: file.buffer,
      contentType: file.mimetype,
      sha256,
      metadata: {
        ownerId,
        originalName: file.originalname,
        sha256,
        isPrivate: "true",
      },
    });

    // Server-managed private access URL
    const cdnUrl = `/api/v1/uploads/media/${storageKey}`;

    // 3. Persist asset in ads_media_assets and location records
    const [asset] = await this.db
      .insert(adsMediaAssets)
      .values({
        ownerId,
        storageKey,
        cdnUrl,
        mimeType: file.mimetype,
        bytes: file.size,
        sha256,
        status: "ready",
        primaryProvider: this.storageRouter.getPrimaryAdapter().provider,
        replicationStatus: "ready",
      })
      .returning();

    await this.db
      .insert(adsMediaAssetLocations)
      .values({
        assetId: asset.id,
        provider: this.storageRouter.getPrimaryAdapter().provider,
        role: "primary",
        bucket: "r2-or-firebase",
        storageKey,
        status: "ready",
        bytes: file.size,
        contentType: file.mimetype,
        sha256,
      })
      .onConflictDoNothing();

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
  async uploadPrepared(
    ownerId: string,
    files: Express.Multer.File[],
    manifest: any,
  ) {
    let checked;
    try {
      checked = await validatePreparedImages(files, manifest);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const bucket = this.firebaseStorageService.getBucket();
    if (!bucket)
      throw new ServiceUnavailableException(
        "Media storage is unavailable. Your previous image is unchanged.",
      );
    const groupId = crypto.randomUUID();
    const assets = checked.map((item, index) => {
      const id = crypto.randomUUID(),
        sha256 = crypto
          .createHash("sha256")
          .update(item.file.buffer)
          .digest("hex");
      const ext =
        item.mime === "image/jpeg"
          ? "jpg"
          : item.mime === "image/png"
            ? "png"
            : "webp";
      const storageKey = `photo-${Date.now()}-${id.replace(/-/g, "")}.${ext}`;
      const profile = (
        index === 0 ? manifest.profile : "compact"
      ) as keyof typeof IMAGE_PROFILES;
      return {
        id,
        ownerId,
        storageKey,
        cdnUrl: `/api/v1/uploads/media/${storageKey}`,
        mimeType: item.mime,
        bytes: item.file.buffer.length,
        width: item.width,
        height: item.height,
        sha256,
        status: "ready" as const,
        profile,
        cap: item.cap,
        target: IMAGE_PROFILES[profile].target,
      };
    });
    const preparation = {
      version: 1,
      pipelineVersion: manifest.pipelineVersion ?? 1,
      groupId,
      quality: manifest.quality,
      layout: manifest.layout,
      ratio: manifest.ratio,
      crop: manifest.crop,
      descriptor:
        manifest.pipelineVersion === 2
          ? validatePreparationDescriptor(manifest)
          : null,
      profile: manifest.profile,
      renditions: assets.map((a) => ({
        assetId: a.id,
        url: a.cdnUrl,
        width: a.width,
        height: a.height,
        bytes: a.bytes,
        mimeType: a.mimeType,
        sha256: a.sha256,
        profile: a.profile,
        cap: a.cap,
        target: a.target,
      })),
    };
    const rows = assets.map(({ profile, cap, target, ...asset }) => ({
      ...asset,
      preparation,
    }));
    const uploaded: string[] = [];
    let persistenceStarted = false;
    const response = (asset: any) => ({
      assetId: asset.id,
      storageKey: asset.storageKey,
      cdnUrl: asset.cdnUrl,
      status: asset.status,
      ...imageSpecsView(asset),
    });
    try {
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        uploaded.push(asset.storageKey);
        await this.storageRouter.putObject({
          key: asset.storageKey,
          body: checked[i].file.buffer,
          contentType: asset.mimeType,
          sha256: asset.sha256,
          metadata: {
            ownerId,
            sha256: asset.sha256,
            isPrivate: "true",
            preparationGroupId: groupId,
          },
        });
      }
      persistenceStarted = true;
      const stored = await this.db.transaction(async (tx) => {
        const result = await tx.insert(adsMediaAssets).values(rows).returning();
        if (
          result.length !== rows.length ||
          result.some(
            (row) =>
              row.status !== "ready" ||
              !row.width ||
              !row.height ||
              (row.preparation as any)?.groupId !== groupId,
          )
        )
          throw Error("Prepared image metadata was not saved completely.");
        return result;
      });
      return response(stored.find((a) => a.id === assets[0].id)!);
    } catch (error) {
      let safeToRemove = !persistenceStarted;
      if (persistenceStarted) {
        try {
          const existing = await this.db
            .select()
            .from(adsMediaAssets)
            .where(
              and(
                eq(adsMediaAssets.ownerId, ownerId),
                inArray(
                  adsMediaAssets.id,
                  assets.map((a) => a.id),
                ),
              ),
            );
          if (
            existing.length === rows.length &&
            existing.every(
              (a) =>
                a.status === "ready" &&
                a.width &&
                a.height &&
                (a.preparation as any)?.groupId === groupId,
            )
          )
            return response(existing.find((a) => a.id === assets[0].id)!);
          safeToRemove = existing.length === 0;
        } catch {
          /* An uncertain commit must be reconciled before removing its objects. */
        }
      }
      if (safeToRemove) {
        for (const key of uploaded) {
          try {
            await bucket.file(key).delete({ ignoreNotFound: true });
          } catch {
            this.logger.warn(
              "Prepared image cleanup deferred for an unbound upload.",
            );
          }
        }
      } else
        this.logger.warn(
          "Prepared image persistence is unconfirmed; retain objects for reconciliation.",
        );
      throw new ServiceUnavailableException(
        "The image and its specifications could not be confirmed. Your previous image is unchanged.",
      );
    }
  }
  async readyAsset(ownerId: string, id: string) {
    const [asset] = await this.db
      .select()
      .from(adsMediaAssets)
      .where(
        and(
          eq(adsMediaAssets.id, id),
          eq(adsMediaAssets.ownerId, ownerId),
          eq(adsMediaAssets.status, "ready"),
        ),
      )
      .limit(1);
    if (!asset)
      throw new NotFoundException(
        "Uploaded image is unavailable. Reselect the image before submitting.",
      );
    return {
      assetId: asset.id,
      cdnUrl: asset.cdnUrl,
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      preparation: asset.preparation,
      status: asset.status,
    };
  }

  async presign(params: PresignRequest) {
    // 1. Strict size and MIME restriction validation
    this.validateRestrictions(params.contentType, params.contentLength);

    const sha256 = params.sha256 || crypto.randomBytes(32).toString("hex");
    const ext = params.fileName.split(".").pop() || "bin";
    const storageKey = this.generateStorageKey(
      params.contentType,
      params.ownerId,
      ext,
      sha256,
    );

    if (!this.storageRouter.isConfigured()) {
      throw new ServiceUnavailableException(
        "Media storage is unavailable. No upload URL was created; please try again later.",
      );
    }

    const presigned = await this.storageRouter.createUploadUrl({
      key: storageKey,
      contentType: params.contentType,
      bytes: params.contentLength,
      expiresInSeconds: ADS_MEDIA_UPLOAD_SETTINGS.storage.signedUrlTtlMinutes * 60,
    });
    const uploadUrl = presigned.url;
    const expiresAt = presigned.expiresAt.toISOString();

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
        status: "pending",
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
  async getMediaStream(
    storageKey: string,
    ownerId?: string,
    staffReview = false,
    range?: { start: number; end?: number },
  ) {
    // Validate storageKey format to prevent directory traversal
    if (
      storageKey.includes("/") ||
      storageKey.includes("\\") ||
      storageKey.includes("..")
    ) {
      throw new BadRequestException(
        "Invalid media key format. Subdirectories not permitted.",
      );
    }

    const [asset] = await this.db
      .select()
      .from(adsMediaAssets)
      .where(
        and(
          eq(adsMediaAssets.storageKey, storageKey),
          eq(adsMediaAssets.status, "ready"),
          ...(ownerId ? [eq(adsMediaAssets.ownerId, ownerId)] : []),
        ),
      )
      .limit(1);
    if (!asset) throw new NotFoundException("Media asset not found");
    if (!ownerId && !staffReview) {
      const [approved] = await this.db
        .select({ id: schema.adsCreatives.id })
        .from(schema.adsCreatives)
        .innerJoin(
          schema.adsCampaigns,
          eq(schema.adsCreatives.campaignId, schema.adsCampaigns.id),
        )
        .where(
          and(
            eq(schema.adsCampaigns.advertiserId, asset.ownerId),
            eq(schema.adsCampaigns.status, "active"),
            eq(schema.adsCampaigns.moderationStatus, "approved"),
            eq(schema.adsCreatives.status, "active"),
            eq(schema.adsCreatives.reviewStatus, "approved"),
            or(
              eq(schema.adsCreatives.imageUrl, asset.cdnUrl),
              ...((asset.preparation as any)?.renditions?.[0]?.url
                ? [
                    eq(
                      schema.adsCreatives.imageUrl,
                      (asset.preparation as any).renditions[0].url,
                    ),
                  ]
                : []),
              eq(schema.adsCreatives.videoUrl, asset.cdnUrl),
            ),
          ),
        )
        .limit(1);
      if (!approved)
        throw new NotFoundException("Public media asset not found");
    }
    const bucket = this.firebaseStorageService.getBucket();
    if (!bucket) {
      throw new NotFoundException("Storage bucket not initialized");
    }

    const fileRef = bucket.file(storageKey);
    const [exists] = await fileRef.exists();
    if (!exists) {
      throw new NotFoundException(`Media asset '${storageKey}' not found`);
    }

    const [metadata] = await fileRef.getMetadata();
    const totalSize = Number(metadata.size || asset.bytes || 0);
    let start = 0;
    let end = Math.max(0, totalSize - 1);
    let partial = false;
    if (range) {
      if (
        !Number.isSafeInteger(range.start) ||
        range.start < 0 ||
        range.start >= totalSize
      ) {
        return { rangeInvalid: true as const, totalSize };
      }
      start = range.start;
      end =
        range.end !== undefined
          ? Math.min(range.end, totalSize - 1)
          : totalSize - 1;
      if (!Number.isSafeInteger(end) || end < start)
        return { rangeInvalid: true as const, totalSize };
      partial = true;
    }
    const stream = fileRef.createReadStream({ start, end });

    return {
      stream,
      contentType:
        (metadata.contentType as string) || "application/octet-stream",
      contentLength: end - start + 1,
      totalSize,
      start,
      end,
      partial,
      contentRange: `bytes ${start}-${end}/${totalSize}`,
    };
  }

  /**
   * Finalizes an uploaded asset and marks it ready for creative binding
   */
  async complete(params: CompleteUploadRequest) {
    const [asset] = await this.db
      .select()
      .from(adsMediaAssets)
      .where(
        and(
          eq(adsMediaAssets.id, params.assetId),
          eq(adsMediaAssets.ownerId, params.ownerId),
        ),
      )
      .limit(1);

    if (!asset) {
      throw new NotFoundException("Media asset not found or unauthorized");
    }

    const stat = await this.storageRouter.statObject(asset.storageKey);
    if (!stat) {
      throw new BadRequestException(
        "Upload is incomplete. Upload the file before marking it complete.",
      );
    }
    if (stat.bytes !== asset.bytes) {
      throw new BadRequestException(
        "Uploaded file does not match the expected size or type. Please upload it again.",
      );
    }

    const [updated] = await this.db
      .update(adsMediaAssets)
      .set({
        status: "ready",
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
      .where(
        and(
          eq(adsMediaAssets.id, assetId),
          eq(adsMediaAssets.ownerId, ownerId),
        ),
      )
      .limit(1);

    if (!asset) {
      throw new NotFoundException("Media asset not found or unauthorized");
    }

    const primaryUrl =
      (asset.preparation as any)?.renditions?.[0]?.url || asset.cdnUrl;
    const [attached] = await this.db
      .select({ id: schema.adsCreatives.id })
      .from(schema.adsCreatives)
      .where(
        or(
          eq(schema.adsCreatives.imageUrl, primaryUrl),
          eq(schema.adsCreatives.videoUrl, asset.cdnUrl),
        ),
      )
      .limit(1);
    if (attached)
      throw new BadRequestException(
        "This media belongs to a saved creative and cannot be deleted independently.",
      );
    try {
      if (asset.storageKey) {
        await this.storageRouter.deleteObject(asset.storageKey);
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not delete file from media storage: ${err.message}`,
      );
    }

    const [deleted] = await this.db
      .update(adsMediaAssets)
      .set({
        status: "deleted",
        updatedAt: new Date(),
      })
      .where(eq(adsMediaAssets.id, assetId))
      .returning();

    return deleted;
  }
}
