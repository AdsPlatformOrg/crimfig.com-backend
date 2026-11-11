import { sql, type SQL } from 'drizzle-orm';
import { eventCampaignId } from './event-attribution';

export interface ClickScope {
  campaign?: SQL;
  from?: string;
  to?: string;
}

/** Receipts and explicitly linked interactions represent one observation. */
export function observedClickRows({ campaign, from, to }: ClickScope = {}) {
  const receiptScope = campaign ? sql`and r.campaign_id in (${campaign})` : sql``;
  const eventScope = campaign ? sql`and ${eventCampaignId} in (${campaign})` : sql``;
  const period = (at: SQL) => sql`
    ${from ? sql`and ${at} >= ${from}::timestamptz` : sql``}
    ${to ? sql`and ${at} < ${to}::timestamptz` : sql``}
  `;
  return sql`
    select r.id, r.id as receipt_id, r.clicked_at as at, r.campaign_id, r.serve_id,
      i.id as event_id, i.is_valid as valid, coalesce(i.invalid_reason, r.recording_reason) as reason,
      s.website_id, s.slot_id, coalesce(case when s.website_id is not null then 'embed' end, i.source, 'share_link') as source
    from ads_clicks r
    left join ads_serves s on s.id = r.serve_id
    left join ads_interactions i on i.id = r.interaction_id and i.type = 'click'
      and i.serve_id is not distinct from r.serve_id and i.promoter_id = r.promoter_id
      and ((s.id is not null and (i.placement_id is null or i.placement_id = s.placement_id))
        or (r.serve_id is null and exists (
          select 1 from ads_placements p where p.id = i.placement_id
            and p.campaign_id = r.campaign_id and p.promoter_id = i.promoter_id
        )))
    where (r.serve_id is null or (s.inventory_class = 'paid' and s.delivery_mode <> 'shadow'
      and s.campaign_id = r.campaign_id and s.promoter_id = r.promoter_id))
      ${receiptScope} ${period(sql`r.clicked_at`)}
    union all
    select ads_interactions.id, null::uuid, ads_interactions.created_at, ${eventCampaignId}, ads_interactions.serve_id,
      ads_interactions.id, ads_interactions.is_valid, ads_interactions.invalid_reason,
      ads_serves.website_id, ads_serves.slot_id,
      coalesce(case when ads_serves.website_id is not null then 'embed' end, ads_interactions.source, 'share_link')
    from ads_interactions
    left join ads_placements on ads_placements.id = ads_interactions.placement_id
    left join ads_serves on ads_serves.id = ads_interactions.serve_id
    where ads_interactions.type = 'click' and ${eventCampaignId} is not null
      ${eventScope} ${period(sql`ads_interactions.created_at`)}
      and not exists (
        select 1 from ads_clicks r where r.interaction_id = ads_interactions.id
          and r.campaign_id = ${eventCampaignId} and r.serve_id is not distinct from ads_interactions.serve_id
          and r.promoter_id = ads_interactions.promoter_id
      )
  `;
}

export const billedClick = sql`exists (
  select 1 from ads_settlement_claims claim
  join ads_settlement_batches batch on batch.id = claim.batch_id and batch.status = 'completed'
  join ads_promoter_settlement_items item on item.batch_id = batch.id
    and item.idempotency_key = 'ads-item:v3:' || claim.interaction_id::text and item.billed_usd_cents > 0
  join billing_transactions debit on debit.reference = 'ads-spend-v3-' || batch.id::text
    and debit.status = 'completed' and debit.type = 'ads_spend' and debit.provider = 'internal'
  where claim.interaction_id = click.event_id and claim.serve_id = click.serve_id
    and item.campaign_id = click.campaign_id and item.clicks_count > 0
)`;
