import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { adsDisputes, AdsDispute, NewAdsDispute } from '@crimfig/database/schema';
import { eq, desc, and } from 'drizzle-orm';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * File a new dispute or traffic quality appeal
   */
  async createDispute(payload: {
    openedBy: string;
    role: 'advertiser' | 'promoter';
    scope: 'campaign' | 'placement' | 'general';
    campaignId?: string;
    placementId?: string;
    periodFrom: string;
    periodTo: string;
    reason: string;
    details: string;
  }): Promise<AdsDispute> {
    const newRecord: NewAdsDispute = {
      openedBy: payload.openedBy,
      role: payload.role,
      scope: payload.scope,
      campaignId: payload.campaignId || null,
      placementId: payload.placementId || null,
      periodFrom: new Date(payload.periodFrom),
      periodTo: new Date(payload.periodTo),
      reason: payload.reason,
      details: payload.details,
      status: 'open',
    };

    const [dispute] = await this.db
      .insert(adsDisputes)
      .values(newRecord)
      .returning();

    this.logger.log(`[Dispute Created] id=${dispute.id} role=${dispute.role} scope=${dispute.scope}`);
    return dispute;
  }

  /**
   * List disputes for a user or admin
   */
  async getDisputes(filters: {
    openedBy?: string;
    role?: 'advertiser' | 'promoter';
    status?: string;
    limit?: number;
  }): Promise<AdsDispute[]> {
    const conditions: any[] = [];

    if (filters.openedBy) {
      conditions.push(eq(adsDisputes.openedBy, filters.openedBy));
    }
    if (filters.role) {
      conditions.push(eq(adsDisputes.role, filters.role));
    }
    if (filters.status) {
      conditions.push(eq(adsDisputes.status, filters.status as any));
    }

    const query = this.db
      .select()
      .from(adsDisputes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(adsDisputes.createdAt))
      .limit(filters.limit || 50);

    return query;
  }

  /**
   * Get single dispute dossier
   */
  async getDisputeById(id: string): Promise<AdsDispute> {
    const [dispute] = await this.db
      .select()
      .from(adsDisputes)
      .where(eq(adsDisputes.id, id));

    if (!dispute) {
      throw new NotFoundException(`Dispute not found: ${id}`);
    }

    return dispute;
  }

  /**
   * Resolve a dispute (Admin action)
   */
  async resolveDispute(
    id: string,
    payload: {
      outcome: string;
      status: 'resolved_adjusted' | 'resolved_upheld' | 'rejected';
      adjustmentMicros?: number;
      adminId?: string;
    },
  ): Promise<AdsDispute> {
    const [dispute] = await this.db
      .update(adsDisputes)
      .set({
        status: payload.status,
        outcome: payload.outcome,
        adjustmentMicros: payload.adjustmentMicros || 0,
        resolvedBy: payload.adminId || null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(adsDisputes.id, id))
      .returning();

    if (!dispute) {
      throw new NotFoundException(`Dispute not found: ${id}`);
    }

    this.logger.log(`[Dispute Resolved] id=${id} status=${payload.status} adjustmentMicros=${payload.adjustmentMicros}`);
    return dispute;
  }
}
