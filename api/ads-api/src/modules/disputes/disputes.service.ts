import { Injectable, Logger, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
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
    if ((payload.scope === 'campaign' && !payload.campaignId) ||
        (payload.scope === 'placement' && !payload.placementId) ||
        (payload.scope === 'general' && (payload.campaignId || payload.placementId))) {
      throw new BadRequestException('Dispute scope and resource references must match');
    }
    const from = new Date(payload.periodFrom), to = new Date(payload.periodTo);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
      throw new BadRequestException('Dispute period is invalid');
    }
    if (payload.campaignId) {
      if (payload.role !== 'advertiser') throw new BadRequestException('Promoter disputes must reference an owned placement');
      const [campaign] = await this.db.select().from(schema.adsCampaigns).where(and(
        eq(schema.adsCampaigns.id, payload.campaignId), eq(schema.adsCampaigns.advertiserId, payload.openedBy),
      )).limit(1);
      if (!campaign) throw new NotFoundException('Campaign not found');
    }
    if (payload.placementId) {
      const [placement] = await this.db.select({ id: schema.adsPlacements.id }).from(schema.adsPlacements)
        .innerJoin(schema.adsPromoters, eq(schema.adsPlacements.promoterId, schema.adsPromoters.id))
        .innerJoin(schema.adsCampaigns, eq(schema.adsPlacements.campaignId, schema.adsCampaigns.id))
        .where(and(eq(schema.adsPlacements.id, payload.placementId),
          payload.role === 'promoter' ? eq(schema.adsPromoters.userId, payload.openedBy) : eq(schema.adsCampaigns.advertiserId, payload.openedBy),
          ...(payload.campaignId ? [eq(schema.adsPlacements.campaignId, payload.campaignId)] : []),
        )).limit(1);
      if (!placement) throw new NotFoundException('Placement not found');
    }
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
    openedBy: string;
    role?: 'advertiser' | 'promoter';
    status?: string;
    limit?: number;
  }): Promise<AdsDispute[]> {
    if (!filters.openedBy) throw new NotFoundException('Dispute owner is required');
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
  async getDisputeById(id: string, openedBy: string): Promise<AdsDispute> {
    if (!openedBy) throw new NotFoundException('Dispute not found');
    const [dispute] = await this.db
      .select()
      .from(adsDisputes)
      .where(and(eq(adsDisputes.id, id), eq(adsDisputes.openedBy, openedBy)));

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
