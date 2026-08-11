import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class RecordConsentDto {
  @ApiProperty({ description: 'OAuth client_id of the app', example: 'crimfig_ads' })
  @IsString() @IsNotEmpty()
  appClientId!: string;

  @ApiProperty({ description: 'Terms version being accepted', example: '2026-01' })
  @IsString() @IsNotEmpty()
  termsVersion!: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ConsentService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Record that a user has accepted the Terms of Service for a given app.
   * Called during the OAuth consent flow on auth.crimfig.com.
   */
  async recordConsent(
    userId: string,
    dto: RecordConsentDto,
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    // Look up the app by client_id
    const app = await this.db.query.apps.findFirst({
      where: eq(schema.apps.clientId, dto.appClientId),
    });
    if (!app) throw new NotFoundException(`App '${dto.appClientId}' not found`);

    // Upsert: insert or update existing consent record
    const existing = await this.db.query.userAppConsents.findFirst({
      where: and(
        eq(schema.userAppConsents.userId, userId),
        eq(schema.userAppConsents.appId, app.id),
      ),
    });

    if (existing) {
      await this.db.update(schema.userAppConsents)
        .set({
          termsVersionAccepted: dto.termsVersion,
          agreedAt: new Date(),
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
        })
        .where(eq(schema.userAppConsents.id, existing.id));
      return { consented: true, updated: true };
    }

    await this.db.insert(schema.userAppConsents).values({
      userId,
      appId: app.id,
      termsVersionAccepted: dto.termsVersion,
      agreedAt: new Date(),
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    });

    return { consented: true, updated: false };
  }

  /**
   * Check if a user has active consent for a given app and terms version.
   * Used by OAuthService and AppConsentGuard to gate token issuance.
   */
  async hasConsent(userId: string, appClientId: string, requiredTermsVersion?: string): Promise<boolean> {
    const app = await this.db.query.apps.findFirst({
      where: eq(schema.apps.clientId, appClientId),
    });
    if (!app) return false;

    const consent = await this.db.query.userAppConsents.findFirst({
      where: and(
        eq(schema.userAppConsents.userId, userId),
        eq(schema.userAppConsents.appId, app.id),
      ),
    });
    if (!consent) return false;

    // If a specific version is required, check it matches
    if (requiredTermsVersion && consent.termsVersionAccepted !== requiredTermsVersion) {
      return false;
    }

    return true;
  }

  /**
   * Get the full consent history for a user and app.
   */
  async getConsent(userId: string, appClientId: string) {
    const app = await this.db.query.apps.findFirst({
      where: eq(schema.apps.clientId, appClientId),
    });
    if (!app) throw new NotFoundException(`App '${appClientId}' not found`);

    const consent = await this.db.query.userAppConsents.findFirst({
      where: and(
        eq(schema.userAppConsents.userId, userId),
        eq(schema.userAppConsents.appId, app.id),
      ),
    });

    return {
      appClientId,
      appName: app.name,
      consented: !!consent,
      termsVersionAccepted: consent?.termsVersionAccepted ?? null,
      agreedAt: consent?.agreedAt ?? null,
    };
  }
}
