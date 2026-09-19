import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

export async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;

  const pool = connectionString
    ? new Pool({
        connectionString,
        ssl: process.env.DB_SSL === 'true' || connectionString.includes('railway') ? { rejectUnauthorized: false } : false,
      })
    : new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'crimfig_core',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      });

  const db = drizzle(pool);

  const migrationsFolder = path.resolve(__dirname, '../migrations');
  console.log(`[Drizzle Migrate] Running migrations from: ${migrationsFolder}`);

  try {
    await migrate(db, { migrationsFolder });
    console.log('[Drizzle Migrate] All migrations applied successfully to crimfig_core!');
  } catch (error) {
    console.error('[Drizzle Migrate] Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
