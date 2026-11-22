import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './index';

export type ReleaseService = 'ads' | 'billing' | 'auth';

const tableNames: Record<ReleaseService, string[]> = {
  ads: [
    'users', 'ads_campaigns', 'ads_creative_stacks', 'ads_creatives', 'ads_house_creatives',
    'ads_promoters', 'ads_promoter_websites', 'ads_placements', 'adstation_slots',
    'ads_serves', 'ads_interactions', 'ads_clicks', 'ads_opportunity_reservations',
    'ads_auction_decisions', 'ads_event_assessments', 'ads_evidence_records',
    'advertiser_achievements', 'advertiser_recognition_awards', 'advertiser_recognition_evaluations',
    'billing_wallets', 'billing_transactions', 'billing_provider_events', 'ads_campaign_escrows',
    'ads_settlement_claims', 'ads_settlement_batches', 'ads_promoter_settlement_items',
    'ads_moderation_decisions', 'ads_settlement_rebates',
    'program_feature_switches', 'program_feature_switch_audit', 'platform_operating_reserve',
    'platform_reserve_transfers', 'advertiser_bonus_credits', 'advertiser_bonus_ledger',
    'platform_admin_silent_alerts', 'bonus_promo_impressions',
  ],
  billing: [
    'users', 'billing_wallets', 'billing_transactions', 'billing_exchange_rates',
    'billing_subscriptions', 'billing_provider_events', 'billing_bank_accounts',
    'billing_withdrawal_requests', 'ads_campaigns', 'ads_campaign_escrows',
    'ads_opportunity_reservations', 'ads_settlement_claims', 'ads_settlement_batches',
    'ads_settlement_carries', 'ads_promoter_settlement_items',
  ],
  auth: [
    'users', 'individual_profiles', 'organizations', 'organization_members',
    'apps', 'user_app_consents', 'mfa_devices', 'oauth_clients', 'refresh_tokens',
  ],
};

export async function requireServiceSchema(
  db: { execute: (query: any) => Promise<any> },
  service: ReleaseService,
) {
  const required = Object.values(schema).flatMap(value => {
    try {
      const table = getTableConfig(value as any);
      return tableNames[service].includes(table.name) ? [table] : [];
    } catch { return []; }
  });
  if (required.length !== tableNames[service].length) throw new Error('Release schema manifest is incomplete');
  const result = await db.execute(sql`
    select table_name, column_name, udt_name from information_schema.columns
    where table_schema = 'public'
  `);
  const actual = new Map<string, string>((result.rows ?? result).map((row: any) =>
    [row.table_name + '.' + row.column_name, row.udt_name]));
  const types: Record<string, string> = {
    'character varying': 'varchar', varchar: 'varchar', integer: 'int4',
    bigint: 'int8', smallint: 'int2', boolean: 'bool', serial: 'int4', bigserial: 'int8',
    'timestamp with time zone': 'timestamptz', timestamp: 'timestamp',
    'double precision': 'float8', real: 'float4', numeric: 'numeric',
  };
  for (const table of required) {
    for (const column of table.columns) {
      const found = actual.get(table.name + '.' + column.name);
      if (!found) throw new Error('Required service schema unavailable');
      const type = column.getSQLType().replace(/\(\d+(?:,\s*\d+)?\)/g, '').replace(/"/g, '');
      const expected = type.endsWith('[]') ? '_' + (types[type.slice(0, -2)] ?? type.slice(0, -2)) : types[type] ?? type;
      if (found !== expected) throw new Error('Required service schema incompatible: ' + table.name + '.' + column.name + ' expected ' + expected + ' received ' + found);
    }
  }
  const enums = await db.execute(sql`
    select t.typname as name, e.enumlabel as value
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
  `);
  const enumValues = new Set((enums.rows ?? enums).map((row: any) => row.name + ':' + row.value));
  for (const table of required) {
    for (const column of table.columns) {
      const definition = (column as any).enum;
      if (definition) {
        for (const value of definition.enumValues) {
          if (!enumValues.has(definition.enumName + ':' + value)) throw new Error('Required service enum unavailable');
        }
      }
    }
  }
  const indexes = await db.execute(sql`
    select c.relname as name, t.relname as table_name from pg_index i
    join pg_class c on c.oid = i.indexrelid join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and i.indisvalid and i.indisready
  `);
  const availableIndexes = new Set((indexes.rows ?? indexes).map((row: any) => row.table_name + ':' + row.name));
  for (const table of required) {
    for (const index of table.indexes) {
      if (!availableIndexes.has(table.name + ':' + index.config.name)) throw new Error('Required service index unavailable');
    }
  }
}
