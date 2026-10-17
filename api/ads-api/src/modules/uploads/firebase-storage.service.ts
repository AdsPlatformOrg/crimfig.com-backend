import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

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
export class FirebaseStorageService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseStorageService.name);
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
          'Firebase service account credentials missing in environment. File uploads will be mocked or require configuration.',
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
}
