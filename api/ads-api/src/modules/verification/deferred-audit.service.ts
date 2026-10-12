import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import {
  adsEmbedRunAudits,
  adsPromoterWebsites,
  adsPromoterApps,
  adsPlacements,
  adsInteractions,
  adsMetricsHourly,
  adsCampaigns,
  adsPromoterEarnings,
} from '@crimfig/database/schema';
import { and, eq, inArray, sql, desc, gte } from 'drizzle-orm';
import { AdsSettlementService } from '../billing/ads-settlement.service';

@Injectable()
export class DeferredAuditService {
  private readonly logger = new Logger(DeferredAuditService.name);
  private isProcessing = false;

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly settlementService: AdsSettlementService,
  ) {}

  /**
   * Scheduled cron worker running every 30 minutes.
   * Processes deferred verification audits, validates partner domains/bundle IDs,
   * detects domain spoofing, aggregates hourly metric rollups, and executes batch settlements.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleDeferredAuditCron() {
    if (this.isProcessing) {
      this.logger.warn('Previous audit cron job still running. Skipping iteration.');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();
    this.logger.log('Starting deferred verification & batch audit cycle...');

    try {
      const auditsProcessed = await this.processEmbedAudits();
      const rollupsGenerated = await this.aggregateHourlyMetrics();

      // Trigger the 30-minute deferred batch settlement engine
      let settlementBatch: any = null;
      try {
        settlementBatch = await this.settlementService.processPendingSettlement();
      } catch (settleErr: any) {
        this.logger.error(`Settlement engine error during deferred audit: ${settleErr.message}`, settleErr.stack);
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Deferred audit cycle completed in ${durationMs}ms: ${auditsProcessed} audits processed, ${rollupsGenerated} hourly rollups updated, batch ${settlementBatch?.batchNumber || 'N/A'}.`,
      );
    } catch (error: any) {
      this.logger.error(`Error during deferred audit cron cycle: ${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Manual trigger method for tests and on-demand administrator execution
   */
  async triggerManualAudit() {
    return this.handleDeferredAuditCron();
  }

  /**
   * Process pending embed execution audit records
   */
  private async processEmbedAudits(): Promise<number> {
    const pendingAudits = await this.db
      .select()
      .from(adsEmbedRunAudits)
      .where(eq(adsEmbedRunAudits.isProcessed, false))
      .limit(500);

    if (pendingAudits.length === 0) {
      return 0;
    }

    const processedIds: string[] = [];

    for (const audit of pendingAudits) {
      try {
        let flag: string | null = null;

        // If associated with a website placement
        if (audit.websiteId || audit.domain) {
          const conditions: any[] = [];
          if (audit.websiteId) conditions.push(eq(adsPromoterWebsites.id, audit.websiteId));
          else if (audit.domain) conditions.push(eq(adsPromoterWebsites.domain, audit.domain.toLowerCase().trim()));

          const [website] = await this.db
            .select()
            .from(adsPromoterWebsites)
            .where(and(...conditions))
            .limit(1);

          if (website) {
            // Verify domain match
            const auditDomain = audit.domain ? audit.domain.toLowerCase().trim() : '';
            const registeredDomain = website.domain.toLowerCase().trim();

            if (auditDomain && auditDomain !== registeredDomain && !auditDomain.endsWith(`.${registeredDomain}`)) {
              flag = 'domain_mismatch_origin_spoof';
              this.logger.warn(
                `Domain mismatch detected on embed ping: auditDomain=${auditDomain}, registeredDomain=${registeredDomain}`,
              );
            } else {
              // Valid ping - update last ping timestamp
              const updates: any = { embedPingLastAt: audit.runTimestamp };

              // If website was pending and ping origin matches registered domain, auto-promote to verified
              if (website.verificationStatus === 'pending') {
                updates.verificationStatus = 'verified';
                updates.verifiedAt = new Date();
                this.logger.log(`Website ${website.domain} auto-verified via verified embed execution ping.`);
              }

              await this.db.update(adsPromoterWebsites).set(updates).where(eq(adsPromoterWebsites.id, website.id));
            }
          } else {
            flag = 'unknown_website_target';
          }
        }

        // If associated with a mobile app placement
        if (audit.appId || audit.bundleId) {
          const conditions: any[] = [];
          if (audit.appId) conditions.push(eq(adsPromoterApps.id, audit.appId));
          else if (audit.bundleId) conditions.push(eq(adsPromoterApps.bundleId, audit.bundleId.trim()));

          const [app] = await this.db
            .select()
            .from(adsPromoterApps)
            .where(and(...conditions))
            .limit(1);

          if (app && app.verificationStatus === 'pending') {
            await this.db
              .update(adsPromoterApps)
              .set({ verificationStatus: 'verified', verifiedAt: new Date() })
              .where(eq(adsPromoterApps.id, app.id));
            this.logger.log(`App ${app.appName} (${app.bundleId}) auto-verified via verified app execution token.`);
          }
        }

        // Update audit record status
        await this.db
          .update(adsEmbedRunAudits)
          .set({ isProcessed: true, auditFlags: flag })
          .where(eq(adsEmbedRunAudits.id, audit.id));

        processedIds.push(audit.id);
      } catch (err: any) {
        this.logger.error(`Failed processing audit record ${audit.id}: ${err.message}`);
      }
    }

    return processedIds.length;
  }

  /**
   * Aggregate interaction events into hourly metric rollups
   */
  private async aggregateHourlyMetrics(): Promise<number> {
    // Process interactions from the last 2 hours to catch recent activity
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Group recent interactions by placement and hourly bucket
    const recentInteractions = await this.db
      .select({
        placementId: adsInteractions.placementId,
        promoterId: adsInteractions.promoterId,
        type: adsInteractions.type,
        count: sql<number>`count(*)::int`,
        hourBucket: sql<string>`date_trunc('hour', ${adsInteractions.createdAt})`,
      })
      .from(adsInteractions)
      .where(gte(adsInteractions.createdAt, cutoff))
      .groupBy(
        adsInteractions.placementId,
        adsInteractions.promoterId,
        adsInteractions.type,
        sql`date_trunc('hour', ${adsInteractions.createdAt})`,
      );

    if (recentInteractions.length === 0) {
      return 0;
    }

    let updatedRollups = 0;

    for (const record of recentInteractions) {
      const periodStart = new Date(record.hourBucket);

      // Fetch placement to identify campaign and creative
      const [placement] = await this.db
        .select({
          campaignId: adsPlacements.campaignId,
          creativeId: adsPlacements.creativeId,
          costPerImpression: adsCampaigns.costPerImpressionUsdCents,
          costPerClick: adsCampaigns.costPerClickUsdCents,
        })
        .from(adsPlacements)
        .innerJoin(adsCampaigns, eq(adsPlacements.campaignId, adsCampaigns.id))
        .where(eq(adsPlacements.id, record.placementId))
        .limit(1);

      if (!placement) continue;

      const isImpression = record.type === 'impression';
      const isClick = record.type === 'click';
      const isHover = record.type === 'hover';
      const isTouch = record.type === 'touch';

      const impressionCount = isImpression ? record.count : 0;
      const clickCount = isClick ? record.count : 0;
      const hoverCount = isHover ? record.count : 0;
      const touchCount = isTouch ? record.count : 0;

      const spend = impressionCount * placement.costPerImpression + clickCount * placement.costPerClick;
      const earnings = Math.round(spend * 0.7);

      // Upsert into adsMetricsHourly
      await this.db
        .insert(adsMetricsHourly)
        .values({
          campaignId: placement.campaignId,
          creativeId: placement.creativeId,
          promoterId: record.promoterId,
          placementId: record.placementId,
          periodStart,
          impressionsCount: impressionCount,
          clicksCount: clickCount,
          hoversCount: hoverCount,
          touchesCount: touchCount,
          spendUsdCents: spend,
          earningsUsdCents: earnings,
        })
        .onConflictDoUpdate({
          target: [
            adsMetricsHourly.campaignId,
            adsMetricsHourly.creativeId,
            adsMetricsHourly.placementId,
            adsMetricsHourly.periodStart,
          ],
          set: {
            impressionsCount: isImpression
              ? sql`${adsMetricsHourly.impressionsCount} + ${record.count}`
              : adsMetricsHourly.impressionsCount,
            clicksCount: isClick ? sql`${adsMetricsHourly.clicksCount} + ${record.count}` : adsMetricsHourly.clicksCount,
            hoversCount: isHover ? sql`${adsMetricsHourly.hoversCount} + ${record.count}` : adsMetricsHourly.hoversCount,
            touchesCount: isTouch ? sql`${adsMetricsHourly.touchesCount} + ${record.count}` : adsMetricsHourly.touchesCount,
            spendUsdCents: sql`${adsMetricsHourly.spendUsdCents} + ${spend}`,
            earningsUsdCents: sql`${adsMetricsHourly.earningsUsdCents} + ${earnings}`,
            updatedAt: new Date(),
          },
        });

      updatedRollups++;
    }

    return updatedRollups;
  }
}
