import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import {
  MediaStorageAdapter,
  ObjectStat,
  PutObjectInput,
  ReadRange,
  StorageProvider,
} from './storage-adapter.interface';

const cleanEnvVal = (val?: string): string => {
  if (!val) return '';
  let trimmed = val.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
};

@Injectable()
export class FirebaseStorageService implements OnModuleInit, MediaStorageAdapter {
  private readonly logger = new Logger(FirebaseStorageService.name);
  readonly provider: StorageProvider = 'firebase';
  private bucketInstance: any;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    if (getApps().length === 0) {
      const projectId = cleanEnvVal(
        this.configService.get<string>('GSA_PROJECT_ID') || process.env.GSA_PROJECT_ID,
      );
      const clientEmail = cleanEnvVal(
        this.configService.get<string>('GSA_CLIENT_EMAIL') || process.env.GSA_CLIENT_EMAIL,
      );
      let privateKey = cleanEnvVal(
        this.configService.get<string>('GSA_PRIVATE_KEY') || process.env.GSA_PRIVATE_KEY,
      );
      if (privateKey) {
        privateKey = privateKey.replace(/\\n/g, '\n');
      }

      let storageBucket = cleanEnvVal(
        this.configService.get<string>('GSA_STORAGE_BUCKET') || process.env.GSA_STORAGE_BUCKET,
      );
      if (storageBucket.startsWith('gs://')) {
        storageBucket = storageBucket.replace(/^gs:\/\//, '');
      }

      if (!projectId || !clientEmail || !privateKey) {
        this.logger.warn(
          'Firebase service account credentials missing in environment. Firebase fallback dormant.',
        );
        return;
      }

      try {
        initializeApp({
          credential: cert({
            projectId,
            clientEmail,
            privateKey,
          }),
          storageBucket: storageBucket || undefined,
        });
        this.logger.log(`Firebase Storage initialized for project: ${projectId}, bucket: ${storageBucket}`);
      } catch (err: any) {
        this.logger.error(`Failed to initialize Firebase Storage: ${err.message}`, err.stack);
      }
    }

    try {
      this.bucketInstance = getStorage().bucket();
    } catch (e: any) {
      this.logger.warn(`Could not acquire default bucket: ${e.message}`);
    }
  }

  getBucket() {
    return this.bucketInstance;
  }

  isConfigured(): boolean {
    return !!this.bucketInstance;
  }

  async putObject(input: PutObjectInput): Promise<ObjectStat> {
    const bucket = this.getBucket();
    if (!bucket) throw new Error('Firebase Storage bucket is unavailable');

    const file = bucket.file(input.key);
    await file.save(input.body, {
      metadata: {
        contentType: input.contentType,
        metadata: input.metadata,
      },
    });

    return {
      key: input.key,
      bytes: input.body.length,
      contentType: input.contentType,
      sha256: input.sha256,
      lastModified: new Date(),
    };
  }

  async createUploadUrl(input: {
    key: string;
    contentType: string;
    bytes: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers?: Record<string, string>; expiresAt: Date }> {
    const bucket = this.getBucket();
    if (!bucket) throw new Error('Firebase Storage bucket is unavailable');

    const file = bucket.file(input.key);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const [url] = await file.getSignedUrl({
      action: 'write',
      expires: expiresAt,
      contentType: input.contentType,
      version: 'v4',
    });

    return {
      url,
      expiresAt,
    };
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    const bucket = this.getBucket();
    if (!bucket) return null;

    const file = bucket.file(key);
    const [exists] = await file.exists();
    if (!exists) return null;

    const [metadata] = await file.getMetadata();
    return {
      key,
      bytes: Number(metadata.size || 0),
      contentType: metadata.contentType || 'application/octet-stream',
      etag: metadata.etag,
      lastModified: metadata.updated ? new Date(metadata.updated) : undefined,
    };
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
    const bucket = this.getBucket();
    if (!bucket) throw new Error('Firebase Storage bucket is unavailable');

    const file = bucket.file(key);
    const [metadata] = await file.getMetadata();
    const totalSize = Number(metadata.size);
    const contentType = metadata.contentType || 'application/octet-stream';

    if (range) {
      const end = range.end !== undefined ? range.end : totalSize - 1;
      const stream = file.createReadStream({ start: range.start, end });
      return {
        stream,
        contentType,
        contentLength: end - range.start + 1,
        totalSize,
        range: {
          start: range.start,
          end,
          contentRange: `bytes ${range.start}-${end}/${totalSize}`,
        },
      };
    }

    return {
      stream: file.createReadStream(),
      contentType,
      contentLength: totalSize,
      totalSize,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const bucket = this.getBucket();
    if (!bucket) return;
    try {
      await bucket.file(key).delete({ ignoreNotFound: true });
    } catch {
      // Ignored
    }
  }
}
