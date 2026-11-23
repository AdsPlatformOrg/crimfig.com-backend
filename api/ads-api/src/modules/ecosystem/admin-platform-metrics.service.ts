import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@crimfig/database/schema';
import { DATABASE_TOKEN } from '../database/database.module';

const ALLOWED_WINDOW_DAYS = new Set([7, 14, 30, 90]);

export interface PlatformMetricsDailyPoint {
  date: string;
  usersSignedUp: number;
  websitesSetup: number;
  websitesVerified: number;
  slotsCreated: number;
  slotsAdded: number;
}

export interface PlatformMetricsOverview {
  windowDays: number;
  generatedAt: string;
  users: {
    totalSignedUp: number;
    emailVerified: number;
    activeAccounts: number;
    pendingVerification: number;
    suspended: number;
    newInWindow: number;
  };
  websites: {
    totalPromoters: number;
    setup: number;
    verified: number;
    pendingVerification: number;
    failedVerification: number;
    policyApproved: number;
    withSlotsCreated: number;
    withSlotsAdded: number;
    pinging7d: number;
    newInWindow: number;
  };
  adSlots: {
    created: number;
    addedVerified: number;
    liveActive: number;
    pendingInstall: number;
    retired: number;
    newInWindow: number;
    byType: {
      consideration: number;
      network: number;
      direct: number;
      hybrid: number;
    };
  };
  campaigns: {
    advertisersWithCampaigns: number;
    total: number;
    active: number;
    underReview: number;
    draft: number;
    paused: number;
    paidServesInWindow: number;
    houseServesInWindow: number;
  };
  rates: {
    userVerificationPct: number;
    websiteVerificationPct: number;
    websiteSlotCoveragePct: number;
    websiteEmbedInstallPct: number;
    slotInstallPct: number;
  };
  dailySeries: PlatformMetricsDailyPoint[];
}

function intCount(value: unknown): number {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.trunc(num);
}

function pct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  const raw = Math.round((numerator / denominator) * 1000) / 10;
  return Math.min(100, Math.max(0, raw));
}

export function parseMetricsWindowDays(raw?: string | number): number {
  if (raw === undefined || raw === null || raw === '') return 30;
  const text = String(raw).trim();
  if (!/^\d{1,3}$/.test(text)) {
    throw new BadRequestException('Choose 7, 14, 30, or 90 days.');
  }
  const value = Number(text);
  if (!ALLOWED_WINDOW_DAYS.has(value)) {
    throw new BadRequestException('Choose 7, 14, 30, or 90 days.');
  }
  return value;
}

@Injectable()
export class AdminPlatformMetricsService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async getOverview(windowDaysInput?: string | number): Promise<PlatformMetricsOverview> {
    const windowDays = parseMetricsWindowDays(windowDaysInput);
    const intervalSql = sql.raw(`interval '${windowDays} days'`);
    const seriesOffsetSql = sql.raw(`interval '${windowDays - 1} days'`);

    const [
      userSummaryRes,
      websiteSummaryRes,
      slotSummaryRes,
      campaignSummaryRes,
      serveSummaryRes,
      dailySeriesRes,
    ] = await Promise.all([
      this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE status <> 'DELETED')::int AS total_signed_up,
          COUNT(*) FILTER (WHERE status <> 'DELETED' AND is_email_verified = true)::int AS email_verified,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_accounts,
          COUNT(*) FILTER (WHERE status = 'PENDING_VERIFICATION')::int AS pending_verification,
          COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
          COUNT(*) FILTER (WHERE status <> 'DELETED' AND created_at >= NOW() - ${intervalSql})::int AS new_in_window
        FROM users
      `),
      this.db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM ads_promoters WHERE is_active = true AND is_suspended = false) AS total_promoters,
          COUNT(*)::int AS setup,
          COUNT(*) FILTER (WHERE verification_status = 'verified')::int AS verified,
          COUNT(*) FILTER (WHERE verification_status = 'pending')::int AS pending_verification,
          COUNT(*) FILTER (WHERE verification_status = 'failed')::int AS failed_verification,
          COUNT(*) FILTER (WHERE policy_status = 'approved')::int AS policy_approved,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM adstation_slots s
            WHERE s.website_id = ads_promoter_websites.id AND s.retired_at IS NULL
          ))::int AS with_slots_created,
          COUNT(*) FILTER (WHERE embed_ping_last_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM adstation_slots s
            WHERE s.website_id = ads_promoter_websites.id AND s.retired_at IS NULL AND s.installation_status = 'verified'
          ))::int AS with_slots_added,
          COUNT(*) FILTER (WHERE embed_ping_last_at >= NOW() - interval '7 days')::int AS pinging_7d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - ${intervalSql})::int AS new_in_window
        FROM ads_promoter_websites
      `),
      this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE retired_at IS NULL)::int AS created,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND installation_status = 'verified')::int AS added_verified,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND lifecycle_status = 'active' AND is_active = true)::int AS live_active,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND (installation_status IN ('unchecked', 'failed', 'missing') OR lifecycle_status = 'installation_pending'))::int AS pending_install,
          COUNT(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND created_at >= NOW() - ${intervalSql})::int AS new_in_window,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND slot_type = 'consideration')::int AS type_consideration,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND slot_type = 'network')::int AS type_network,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND slot_type = 'direct')::int AS type_direct,
          COUNT(*) FILTER (WHERE retired_at IS NULL AND slot_type = 'hybrid')::int AS type_hybrid
        FROM adstation_slots
      `),
      this.db.execute(sql`
        SELECT
          COUNT(DISTINCT advertiser_id) FILTER (WHERE status <> 'trash')::int AS advertisers_with_campaigns,
          COUNT(*) FILTER (WHERE status <> 'trash')::int AS total,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status IN ('under_review', 'pending_manager_approval'))::int AS under_review,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
          COUNT(*) FILTER (WHERE status = 'paused')::int AS paused
        FROM ads_campaigns
      `),
      this.db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE inventory_class = 'paid' AND delivery_mode = 'normal' AND served_at >= NOW() - ${intervalSql})::int AS paid_serves,
          COUNT(*) FILTER (WHERE inventory_class = 'house' AND delivery_mode = 'normal' AND served_at >= NOW() - ${intervalSql})::int AS house_serves
        FROM ads_serves
      `),
      this.db.execute(sql`
        WITH days AS (
          SELECT generate_series(
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql},
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
            interval '1 day'
          )::date AS day
        ),
        u AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS cnt
          FROM users
          WHERE status <> 'DELETED' AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql}
          GROUP BY 1
        ),
        w_setup AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS cnt
          FROM ads_promoter_websites
          WHERE created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql}
          GROUP BY 1
        ),
        w_ver AS (
          SELECT (verified_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS cnt
          FROM ads_promoter_websites
          WHERE verification_status = 'verified' AND verified_at IS NOT NULL
            AND verified_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql}
          GROUP BY 1
        ),
        s_cre AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS cnt
          FROM adstation_slots
          WHERE retired_at IS NULL AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql}
          GROUP BY 1
        ),
        s_add AS (
          SELECT (COALESCE(installation_checked_at, created_at) AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS cnt
          FROM adstation_slots
          WHERE retired_at IS NULL AND installation_status = 'verified'
            AND COALESCE(installation_checked_at, created_at) >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - ${seriesOffsetSql}
          GROUP BY 1
        )
        SELECT
          to_char(days.day, 'YYYY-MM-DD') AS date,
          COALESCE(u.cnt, 0)::int AS users_signed_up,
          COALESCE(w_setup.cnt, 0)::int AS websites_setup,
          COALESCE(w_ver.cnt, 0)::int AS websites_verified,
          COALESCE(s_cre.cnt, 0)::int AS slots_created,
          COALESCE(s_add.cnt, 0)::int AS slots_added
        FROM days
        LEFT JOIN u ON u.day = days.day
        LEFT JOIN w_setup ON w_setup.day = days.day
        LEFT JOIN w_ver ON w_ver.day = days.day
        LEFT JOIN s_cre ON s_cre.day = days.day
        LEFT JOIN s_add ON s_add.day = days.day
        ORDER BY days.day ASC
      `),
    ]);

    const u = userSummaryRes.rows?.[0] ?? {};
    const w = websiteSummaryRes.rows?.[0] ?? {};
    const s = slotSummaryRes.rows?.[0] ?? {};
    const c = campaignSummaryRes.rows?.[0] ?? {};
    const sv = serveSummaryRes.rows?.[0] ?? {};

    const users = {
      totalSignedUp: intCount(u.total_signed_up),
      emailVerified: intCount(u.email_verified),
      activeAccounts: intCount(u.active_accounts),
      pendingVerification: intCount(u.pending_verification),
      suspended: intCount(u.suspended),
      newInWindow: intCount(u.new_in_window),
    };

    const websites = {
      totalPromoters: intCount(w.total_promoters),
      setup: intCount(w.setup),
      verified: intCount(w.verified),
      pendingVerification: intCount(w.pending_verification),
      failedVerification: intCount(w.failed_verification),
      policyApproved: intCount(w.policy_approved),
      withSlotsCreated: intCount(w.with_slots_created),
      withSlotsAdded: intCount(w.with_slots_added),
      pinging7d: intCount(w.pinging_7d),
      newInWindow: intCount(w.new_in_window),
    };

    const adSlots = {
      created: intCount(s.created),
      addedVerified: intCount(s.added_verified),
      liveActive: intCount(s.live_active),
      pendingInstall: intCount(s.pending_install),
      retired: intCount(s.retired),
      newInWindow: intCount(s.new_in_window),
      byType: {
        consideration: intCount(s.type_consideration),
        network: intCount(s.type_network),
        direct: intCount(s.type_direct),
        hybrid: intCount(s.type_hybrid),
      },
    };

    const campaigns = {
      advertisersWithCampaigns: intCount(c.advertisers_with_campaigns),
      total: intCount(c.total),
      active: intCount(c.active),
      underReview: intCount(c.under_review),
      draft: intCount(c.draft),
      paused: intCount(c.paused),
      paidServesInWindow: intCount(sv.paid_serves),
      houseServesInWindow: intCount(sv.house_serves),
    };

    const dailySeries: PlatformMetricsDailyPoint[] = (dailySeriesRes.rows ?? [])
      .filter((row: any) => typeof row?.date === 'string' && row.date.length > 0)
      .map((row: any) => ({
        date: row.date,
        usersSignedUp: intCount(row.users_signed_up),
        websitesSetup: intCount(row.websites_setup),
        websitesVerified: intCount(row.websites_verified),
        slotsCreated: intCount(row.slots_created),
        slotsAdded: intCount(row.slots_added),
      }));

    return {
      windowDays,
      generatedAt: new Date().toISOString(),
      users,
      websites,
      adSlots,
      campaigns,
      rates: {
        userVerificationPct: pct(users.emailVerified, users.totalSignedUp),
        websiteVerificationPct: pct(websites.verified, websites.setup),
        websiteSlotCoveragePct: pct(websites.withSlotsCreated, websites.setup),
        websiteEmbedInstallPct: pct(websites.withSlotsAdded, websites.setup),
        slotInstallPct: pct(adSlots.addedVerified, adSlots.created),
      },
      dailySeries,
    };
  }
}
