import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MediaStorageAdapter,
  ObjectStat,
  PutObjectInput,
  ReadRange,
  StorageProvider,
} from './storage-adapter.interface';
import { Readable } from 'stream';

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
export class CloudflareR2StorageService implements MediaStorageAdapter {
  private readonly logger = new Logger(CloudflareR2StorageService.name);
  readonly provider: StorageProvider = 'cloudflare_r2';

  private s3Client: S3Client | null = null;
  private bucket: string = '';
  private publicBaseUrl: string = '';

  constructor(private readonly configService: ConfigService) {
    this.initClient();
  }

  private initClient() {
    const accountId = cleanEnvVal(
      this.configService.get<string>('R2_ACCOUNT_ID') || process.env.R2_ACCOUNT_ID,
    );
    const accessKeyId = cleanEnvVal(
      this.configService.get<string>('R2_ACCESS_KEY_ID') || process.env.R2_ACCESS_KEY_ID,
    );
    const secretAccessKey = cleanEnvVal(
      this.configService.get<string>('R2_SECRET_ACCESS_KEY') || process.env.R2_SECRET_ACCESS_KEY,
    );
    this.bucket = cleanEnvVal(
      this.configService.get<string>('R2_BUCKET_NAME') ||
        this.configService.get<string>('R2_BUCKET') ||
        process.env.R2_BUCKET_NAME ||
        process.env.R2_BUCKET,
    );
    const explicitEndpoint = cleanEnvVal(
      this.configService.get<string>('R2_S3_ENDPOINT') ||
        this.configService.get<string>('R2_ENDPOINT') ||
        process.env.R2_S3_ENDPOINT ||
        process.env.R2_ENDPOINT,
    );
    this.publicBaseUrl = cleanEnvVal(
      this.configService.get<string>('R2_PUBLIC_BASE_URL') || process.env.R2_PUBLIC_BASE_URL,
    );

    const endpoint = explicitEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

    if (endpoint && accessKeyId && secretAccessKey && this.bucket) {
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.logger.log(`Cloudflare R2 storage initialized for bucket: ${this.bucket}`);
    } else {
      this.logger.warn(
        'Cloudflare R2 storage credentials incomplete; R2 adapter unconfigured or dormant',
      );
    }
  }

  isConfigured(): boolean {
    return !!this.s3Client && !!this.bucket;
  }

  async putObject(input: PutObjectInput): Promise<ObjectStat> {
    if (!this.s3Client) throw new Error('Cloudflare R2 is not configured');

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      Metadata: input.metadata,
    });

    const res = await this.s3Client.send(command);

    return {
      key: input.key,
      bytes: input.body.length,
      contentType: input.contentType,
      etag: res.ETag,
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
    if (!this.s3Client) throw new Error('Cloudflare R2 is not configured');

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: input.expiresInSeconds,
    });

    return {
      url,
      headers: {
        'Content-Type': input.contentType,
      },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    if (!this.s3Client) return null;

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      const res = await this.s3Client.send(command);
      return {
        key,
        bytes: res.ContentLength || 0,
        contentType: res.ContentType || 'application/octet-stream',
        etag: res.ETag,
        lastModified: res.LastModified,
      };
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
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
    if (!this.s3Client) throw new Error('Cloudflare R2 is not configured');

    let rangeHeader: string | undefined = undefined;
    if (range) {
      rangeHeader = `bytes=${range.start}-${range.end !== undefined ? range.end : ''}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: rangeHeader,
    });

    const res = await this.s3Client.send(command);
    const stream = res.Body as Readable;
    const contentType = res.ContentType || 'application/octet-stream';
    const contentLength = res.ContentLength || 0;

    let totalSize = contentLength;
    let rangeResult: { start: number; end: number; contentRange: string } | undefined = undefined;

    if (res.ContentRange) {
      // ContentRange format: bytes start-end/total
      const match = res.ContentRange.match(/bytes (\d+)-(\d+)\/(\d+|\*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        totalSize = match[3] === '*' ? contentLength : parseInt(match[3], 10);
        rangeResult = {
          start,
          end,
          contentRange: res.ContentRange,
        };
      }
    }

    return {
      stream,
      contentType,
      contentLength,
      totalSize,
      range: rangeResult,
    };
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.s3Client) return;

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.s3Client.send(command);
  }

  publicUrl(key: string): string | null {
    if (!this.publicBaseUrl) return null;
    const base = this.publicBaseUrl.replace(/\/+$/, '');
    return `${base}/${key}`;
  }
}
