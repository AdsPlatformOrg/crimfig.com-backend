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

  const fs = require('fs');
  let migrationsFolder = path.resolve(__dirname, '../migrations');
  if (!fs.existsSync(migrationsFolder)) {
    migrationsFolder = path.resolve(__dirname, '../../migrations');
  }
  console.log(`[Drizzle Migrate] Running migrations from: ${migrationsFolder}`);

  try {
    await migrate(db, { migrationsFolder });
    console.log('[Drizzle Migrate] All migrations applied successfully to crimfig_core!');

    // Ensure core first-party ecosystem apps are seeded
    await pool.query(`
      INSERT INTO "apps" ("id", "client_id", "name", "subdomain", "description", "current_terms_version", "is_first_party", "is_active")
      VALUES
        (gen_random_uuid(), 'crimfig_auth', 'CrimFig Central Identity', 'auth.crimfig.com', 'Single Sign-On & Account Management', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_ads', 'CrimFig Ads', 'ads.crimfig.com', 'Advertising & Marketing Platform', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_billing', 'CrimFig Billing', 'billing.crimfig.com', 'Monetization, Wallets & Financial Ledger', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_chat', 'CrimFig Chat', 'chat.crimfig.com', 'Instant Messaging & Community Chat', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_reels', 'CrimFig Reels', 'reels.crimfig.com', 'Short-Form Video Entertainment', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_stream', 'CrimFig Stream', 'stream.crimfig.com', 'Live Streaming & Broadcasts', '1.0.0', true, true),
        (gen_random_uuid(), 'crimfig_tetris', 'CrimFig Tetris', 'tetrisgame.crimfig.com', 'Arcade Gaming Platform', '1.0.0', true, true)
      ON CONFLICT ("client_id") DO NOTHING;
    `);
    console.log('[Drizzle Migrate] Core ecosystem apps verified & seeded successfully!');
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
