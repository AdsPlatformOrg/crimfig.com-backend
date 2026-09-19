import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../schema';

// ─── Config ──────────────────────────────────────────────────────────────────
// Supports both DATABASE_URL (standard in Railway/cloud) and discrete DB credentials.

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.DB_SSL === 'true' || connectionString.includes('railway') ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME || 'crimfig_core',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

// ─── Drizzle Instance ─────────────────────────────────────────────────────────
export const db = drizzle(pool, { schema, logger: process.env.NODE_ENV !== 'production' });

// ─── Health Check ─────────────────────────────────────────────────────────────
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

export { schema };
