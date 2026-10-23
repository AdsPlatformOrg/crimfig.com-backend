import 'reflect-metadata';
import { Pool } from 'pg';
import { DatabaseModule as AdsDatabase } from '../../../api/ads-api/src/modules/database/database.module';
import { DatabaseModule as BillingDatabase } from '../../../api/billing-api/src/modules/database/database.module';
import { HealthController as AdsHealth } from '../../../api/ads-api/src/modules/health/health.controller';
import { HealthController as BillingHealth } from '../../../api/billing-api/src/modules/health/health.controller';

jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('drizzle-orm/node-postgres', () => ({ drizzle: jest.fn(() => ({})) }));

describe('Deployed database configuration and readiness', () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; jest.clearAllMocks(); });

  it.each([['Ads', AdsDatabase], ['Billing', BillingDatabase]])('%s uses the supplied private DATABASE_URL without forced TLS', (_name, module) => {
    process.env.DATABASE_URL = 'postgres://fixture:fixture@postgres.railway.internal:5432/fixture';
    process.env.DB_SSL = 'false';
    Reflect.getMetadata('providers', module)[0].useFactory();
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: process.env.DATABASE_URL, ssl: false, connectionTimeoutMillis: 5000,
    }));
    expect((Pool as unknown as jest.Mock).mock.calls[0][0].host).toBeUndefined();
  });

  it.each([['Ads', AdsDatabase], ['Billing', BillingDatabase]])('%s preserves explicitly enabled TLS', (_name, module) => {
    process.env.DATABASE_URL = 'postgres://fixture:fixture@db.example.com:5432/fixture';
    process.env.DB_SSL = 'true';
    Reflect.getMetadata('providers', module)[0].useFactory();
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: false } }));
  });

  it.each([['Ads', AdsHealth], ['Billing', BillingHealth]])('%s readiness fails with HTTP 503 when its actual database fails', async (_name, controller) => {
    const health = new controller({ execute: jest.fn().mockRejectedValue(new Error('unreachable')) });
    await expect(health.readiness()).rejects.toMatchObject({ status: 503 });
  });
});
