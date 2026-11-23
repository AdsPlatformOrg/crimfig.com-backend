jest.mock('../../src/config/config', () => ({ config: {} }));
import * as schema from '@crimfig/database/schema';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { requiredAdsSchema } from '../../../api/ads-api/src/modules/health/required-schema';
import { HealthController } from '../../../api/ads-api/src/modules/health/health.controller';
import { HealthController as AuthHealth } from '../../src/modules/health/health.controller';

function fixture() {
  const columns: any[] = [], enums: any[] = [], indexes: any[] = [];
  const types: Record<string, string> = { integer: 'int4', bigint: 'int8', smallint: 'int2',
    boolean: 'bool', bigserial: 'int8', serial: 'int4', 'timestamp with time zone': 'timestamptz' };
  for (const value of Object.values(schema)) {
    let table;
    try { table = getTableConfig(value as any); } catch { continue; }
    for (const column of table.columns) {
      const type = column.getSQLType().replace(/\(\d+(?:,\s*\d+)?\)/g, '').replace(/"/g, '');
      columns.push({ table_name: table.name, column_name: column.name, udt_name: type.endsWith('[]') ? '_' + (types[type.slice(0,-2)] ?? type.slice(0,-2)) : types[type] ?? type });
      const definition = (column as any).enum;
      if (definition) for (const value of definition.enumValues) enums.push({ name: definition.enumName, value });
    }
    for (const index of table.indexes) indexes.push({ table_name: table.name, name: index.config.name });
  }
  const db = { execute: jest.fn(async (query: any) => {
    const text = query.queryChunks.map((chunk: any) => chunk.value?.join('') ?? '').join('');
    return { rows: text.includes('information_schema') ? columns : text.includes('pg_enum') ? enums : indexes };
  }) };
  return { db, columns, enums, indexes };
}

describe('release schema readiness', () => {
  it('rejects an Ads release when the recognition migration is missing', async () => {
    const f = fixture();
    for (let index = f.columns.length - 1; index >= 0; index--) {
      if (f.columns[index].table_name === 'advertiser_recognition_awards') f.columns.splice(index, 1);
    }
    await expect(requiredAdsSchema(f.db)).rejects.toThrow('Required service schema unavailable');
  });
  it('rejects missing columns while process liveness stays available', async () => {
    const db = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(requiredAdsSchema(db)).rejects.toThrow('Required service schema unavailable');
    const health = new HealthController(db);
    expect(health.liveness().status).toBe('ok');
    await expect(health.readiness()).rejects.toMatchObject({ status: 503 });
  });
  it('rejects incompatible slot types, missing enum values and missing indexes', async () => {
    const f = fixture();
    const slot = f.columns.find(column => column.table_name === 'adstation_slots' && column.column_name === 'id');
    slot.udt_name = 'text';
    await expect(requiredAdsSchema(f.db)).rejects.toThrow('incompatible');
    slot.udt_name = 'uuid';
    const removed = f.enums.splice(0);
    await expect(requiredAdsSchema(f.db)).rejects.toThrow('enum unavailable');
    f.enums.push(...removed);
    f.indexes.splice(0);
    await expect(requiredAdsSchema(f.db)).rejects.toThrow('index unavailable');
  });
  it('returns HTTP 503 when Auth Redis is unavailable', async () => {
    const f = fixture();
    const auth = new AuthHealth(f.db, { pingRedis: async () => false } as any);
    await expect(auth.readiness()).rejects.toMatchObject({ status: 503 });
  });
  it.each(['ads', 'billing', 'auth'] as const)('accepts the %s manifest with unrelated schemas absent', async service => {
    const f = fixture();
    for (let index = f.columns.length - 1; index >= 0; index--) {
      if (f.columns[index].table_name.startsWith('growth_')) f.columns.splice(index, 1);
    }
    await expect(schema.requireServiceSchema(f.db, service)).resolves.toBeUndefined();
  });
});
