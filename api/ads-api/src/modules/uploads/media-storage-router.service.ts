import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudflareR2StorageService } from './cloudflare-r2-storage.service';
import { FirebaseStorageService } from './firebase-storage.service';
import {
  MediaStorageAdapter,
  ObjectStat,
  PutObjectInput,
  ReadRange,
  StorageProvider,
} from './storage-adapter.interface';

@Injectable()
export class MediaStorageRouter implements MediaStorageAdapter {
  private readonly logger = new Logger(MediaStorageRouter.name);
  readonly provider: StorageProvider = 'cloudflare_r2';

  constructor(
    private readonly configService: ConfigService,
    private readonly r2Storage: CloudflareR2StorageService,
    private readonly firebaseStorage: FirebaseStorageService,
  ) {}

  /**
   * Resolve primary active adapter: prefers Cloudflare R2 if configured; falls back to Firebase.
   */
  getPrimaryAdapter(): MediaStorageAdapter {
    const forceFallback =
      this.configService.get<string>('MEDIA_FORCE_FALLBACK') === 'true' ||
      process.env.MEDIA_FORCE_FALLBACK === 'true';

    if (!forceFallback && this.r2Storage.isConfigured()) {
      return this.r2Storage;
    }

    if (this.firebaseStorage.isConfigured()) {
      return this.firebaseStorage;
    }

    // Default to R2 adapter even if unconfigured (it will throw clean service unavailable errors)
    return this.r2Storage;
  }

  getFallbackAdapter(): MediaStorageAdapter | null {
    if (this.r2Storage.isConfigured() && this.firebaseStorage.isConfigured()) {
      return this.firebaseStorage;
    }
    return null;
  }

  isConfigured(): boolean {
    return this.r2Storage.isConfigured() || this.firebaseStorage.isConfigured();
  }

  async putObject(input: PutObjectInput): Promise<ObjectStat> {
    const primary = this.getPrimaryAdapter();
    const stat = await primary.putObject(input);

    // Warm asynchronous replication to fallback if configured
    const fallback = this.getFallbackAdapter();
    if (fallback && fallback !== primary) {
      fallback.putObject(input).catch((err) => {
        this.logger.warn(
          `Warm standby replication to ${fallback.provider} failed for ${input.key}: ${err.message}`,
        );
      });
    }

    return stat;
  }

  async createUploadUrl(input: {
    key: string;
    contentType: string;
    bytes: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers?: Record<string, string>; expiresAt: Date }> {
    const primary = this.getPrimaryAdapter();
    return primary.createUploadUrl(input);
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    const primary = this.getPrimaryAdapter();
    try {
      const stat = await primary.statObject(key);
      if (stat) return stat;
    } catch (err: any) {
      this.logger.warn(`Primary storage stat failed for ${key}, checking fallback: ${err.message}`);
    }

    const fallback = this.getFallbackAdapter();
    if (fallback) {
      return fallback.statObject(key);
    }
    return null;
  }

  async getObjectStream(
    key: string,
    range?: ReadRange,
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number;
    totalSize: number;
    range?: { start: number; end: number; contentRange: string };
  }> {
    const primary = this.getPrimaryAdapter();
    try {
      return await primary.getObjectStream(key, range);
    } catch (err: any) {
      const fallback = this.getFallbackAdapter();
      if (fallback && fallback !== primary) {
        this.logger.warn(
          `Primary storage stream failed for ${key}, falling back to ${fallback.provider}: ${err.message}`,
        );
        return await fallback.getObjectStream(key, range);
      }
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await Promise.allSettled([
      this.r2Storage.isConfigured() ? this.r2Storage.deleteObject(key) : Promise.resolve(),
      this.firebaseStorage.isConfigured()
        ? this.firebaseStorage.deleteObject(key)
        : Promise.resolve(),
    ]);
  }

  publicUrl(key: string): string | null {
    if (this.r2Storage.isConfigured() && this.r2Storage.publicUrl) {
      const r2Url = this.r2Storage.publicUrl(key);
      if (r2Url) return r2Url;
    }
    return null;
  }
}
