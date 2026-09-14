import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME || 'crimfig_core',
  user: process.env.DB_USER || 'crimfig_user',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

const db = drizzle(pool, { schema });

async function seed() {
  console.log('🌱 Starting database seed...');

  const initialApps = [
    {
      clientId: 'crimfig_auth',
      name: 'CrimFig Central Identity',
      subdomain: 'auth.crimfig.com',
      description: 'Single Sign-On & Account Management',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
    {
      clientId: 'crimfig_ads',
      name: 'CrimFig Ads',
      subdomain: 'ads.crimfig.com',
      description: 'Advertising & Marketing Platform',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
    {
      clientId: 'crimfig_chat',
      name: 'CrimFig Chat',
      subdomain: 'chat.crimfig.com',
      description: 'Instant Messaging & Community Chat',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
    {
      clientId: 'crimfig_reels',
      name: 'CrimFig Reels',
      subdomain: 'reels.crimfig.com',
      description: 'Short-Form Video Entertainment',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
    {
      clientId: 'crimfig_stream',
      name: 'CrimFig Stream',
      subdomain: 'stream.crimfig.com',
      description: 'Live Video Broadcast & Streaming',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
    {
      clientId: 'crimfig_tetris',
      name: 'CrimFig Tetris',
      subdomain: 'tetrisgame.crimfig.com',
      description: 'Classic & Competitive Arcade Gaming',
      currentTermsVersion: '1.0.0',
      isFirstParty: true,
      isActive: true,
    },
  ];

  for (const app of initialApps) {
    const existing = await db.query.apps.findFirst({
      where: eq(schema.apps.clientId, app.clientId),
    });

    if (!existing) {
      await db.insert(schema.apps).values(app);
      console.log(`  + Seeded App: ${app.name} (${app.clientId})`);
    } else {
      console.log(`  = App already exists: ${app.name}`);
    }
  }

  const initialClients = [
    {
      name: 'CrimFig Central Auth Web Client',
      clientId: 'crimfig_auth',
      redirectUris: JSON.stringify([
        'http://localhost:3000/api/auth/callback',
        'http://localhost:3000/login',
        'https://auth.crimfig.com/api/auth/callback',
      ]),
      allowedScopes: 'openid profile email',
      isFirstParty: true,
      isActive: true,
    },
    {
      name: 'CrimFig Ads Web Client',
      clientId: 'crimfig_ads',
      redirectUris: JSON.stringify([
        'http://localhost:3001/api/auth/callback',
        'https://ads.crimfig.com/api/auth/callback',
      ]),
      allowedScopes: 'openid profile email ads:read ads:write',
      isFirstParty: true,
      isActive: true,
    },
    {
      name: 'CrimFig Chat Client',
      clientId: 'crimfig_chat',
      redirectUris: JSON.stringify([
        'http://localhost:3002/api/auth/callback',
        'https://chat.crimfig.com/api/auth/callback',
      ]),
      allowedScopes: 'openid profile email chat:read chat:write',
      isFirstParty: true,
      isActive: true,
    },
  ];

  for (const client of initialClients) {
    const existing = await db.query.oauthClients.findFirst({
      where: eq(schema.oauthClients.clientId, client.clientId),
    });

    if (!existing) {
      await db.insert(schema.oauthClients).values(client);
      console.log(`  + Seeded OAuth Client: ${client.name} (${client.clientId})`);
    } else {
      console.log(`  = OAuth Client already exists: ${client.name}`);
    }
  }

  console.log('✅ Database seed completed successfully.');
  await pool.end();
}

seed().catch((err) => {
  console.error('❌ Database seed error:', err);
  pool.end();
  process.exit(1);
});
