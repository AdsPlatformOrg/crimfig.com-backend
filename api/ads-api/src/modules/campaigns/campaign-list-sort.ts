import { BadRequestException } from '@nestjs/common';
import { adsCampaigns, adsCreatives, adsInteractions, adsPlacements, adsServes } from '@crimfig/database/schema';
import { sql } from 'drizzle-orm';
import { eventCampaignId } from '../analytics/event-attribution';

export const CAMPAIGN_LIST_SORTS = [
  'newest', 'oldest', 'title', 'title_desc', 'status', 'status_desc',
  'budget', 'budget_desc', 'spend', 'spend_desc', 'creatives', 'creatives_desc',
  'views', 'views_desc', 'clicks', 'clicks_desc', 'ctr', 'ctr_desc',
] as const;

/** Only fixed SQL expressions are accepted; all values remain bound parameters. */
export function campaignListOrder(sort: string) {
  if (typeof sort !== 'string' || !(CAMPAIGN_LIST_SORTS as readonly string[]).includes(sort)) {
    throw new BadRequestException('Invalid campaign sort.');
  }
  const interactions = (type: 'impression' | 'click') => sql`(
    select count(*) from ${adsInteractions}
    left join ${adsPlacements} on ${adsInteractions.placementId} = ${adsPlacements.id}
    left join ${adsServes} on ${adsInteractions.serveId} = ${adsServes.id}
    where ${eventCampaignId} = ${adsCampaigns.id}
      and ${adsInteractions.isValid} = true and ${adsInteractions.type} = ${type}
  )`;
  const key = sort.replace(/_desc$/, '');
  const expression = (() => {
    switch (key) {
      case 'title': return sql`lower(${adsCampaigns.title})`;
      case 'status': return sql`case when ${adsCampaigns.status} <> 'trash' and ${adsCampaigns.moderationStatus} in ('pending_primary_review', 'pending_manager_approval') then 'under_review' else ${adsCampaigns.status}::text end`;
      case 'budget': return sql`${adsCampaigns.budgetUsdCents}`;
      case 'spend': return sql`${adsCampaigns.budgetUsdCents} - ${adsCampaigns.remainingBudgetUsdCents}`;
      case 'creatives': return sql`(select count(*) from ${adsCreatives} where ${adsCreatives.campaignId} = ${adsCampaigns.id} and ${adsCreatives.status} = 'active' and ${adsCreatives.reviewStatus} = 'approved')`;
      case 'views': return interactions('impression');
      case 'clicks': return interactions('click');
      case 'ctr': return sql`coalesce(100.0 * ${interactions('click')} / nullif(${interactions('impression')}, 0), 0)`;
      default: return sql`${adsCampaigns.createdAt}`;
    }
  })();
  return sort === 'newest' || sort.endsWith('_desc') ? sql`${expression} desc` : sql`${expression} asc`;
}
