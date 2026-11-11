import { sql } from 'drizzle-orm';
import { adsInteractions, adsPlacements, adsServes } from '@crimfig/database/schema';

/** Network slots have no campaign-specific placement. A linked serve is authoritative;
 * never fall back to a placement when that serve is missing, non-paid or mismatched.
 * Placement-only legacy events retain their existing reporting semantics.
 */
export const eventCampaignId = sql<string>`CASE
  WHEN ${adsInteractions.serveId} IS NOT NULL THEN CASE
    WHEN ${adsServes.inventoryClass} = 'paid' AND ${adsServes.deliveryMode} <> 'shadow'
      AND ${adsInteractions.promoterId} = ${adsServes.promoterId}
      AND (${adsInteractions.placementId} IS NULL OR (
        ${adsPlacements.campaignId} = ${adsServes.campaignId}
        AND ${adsPlacements.promoterId} = ${adsInteractions.promoterId}
        AND ${adsServes.placementId} = ${adsInteractions.placementId}))
    THEN ${adsServes.campaignId} END
  WHEN ${adsPlacements.promoterId} = ${adsInteractions.promoterId} THEN ${adsPlacements.campaignId}
END`;
