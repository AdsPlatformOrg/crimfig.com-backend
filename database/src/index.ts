import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../schema';

// ─── Config ──────────────────────────────────────────────────────────────────
// Database credentials are read from environment variables.
// In application services, these are provided via each service's config.ts —
// never read process.env directly in business logic outside of config files.

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  max: 20,           // maximum pool connections
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
