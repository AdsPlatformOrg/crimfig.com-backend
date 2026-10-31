export type StorageProvider = 'cloudflare_r2' | 'firebase';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  sha256?: string;
  metadata?: Record<string, string>;
}

export interface ObjectStat {
  key: string;
  bytes: number;
  contentType: string;
  etag?: string;
  sha256?: string;
  lastModified?: Date;
}

export interface ReadRange {
  start: number;
  end?: number;
}

export interface MediaStorageAdapter {
  readonly provider: StorageProvider;
  isConfigured(): boolean;
  putObject(input: PutObjectInput): Promise<ObjectStat>;
  createUploadUrl(input: {
    key: string;
    contentType: string;
    bytes: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers?: Record<string, string>; expiresAt: Date }>;
  statObject(key: string): Promise<ObjectStat | null>;
  getObjectStream(
    key: string,
    range?: ReadRange,
  ): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength: number;
    totalSize: number;
    range?: { start: number; end: number; contentRange: string };
  }>;
  deleteObject(key: string): Promise<void>;
  publicUrl?(key: string): string | null;
}
