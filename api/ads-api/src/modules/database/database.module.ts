import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';

export const DATABASE_TOKEN = 'DATABASE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_TOKEN,
      useFactory: (): NodePgDatabase<typeof schema> => {
        const connectionString = process.env.DATABASE_URL;
        const pool = new Pool({
          ...(connectionString ? { connectionString } : {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT) || 5432,
          database: process.env.DB_NAME || 'crimfig',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
          }),
          max: Number(process.env.DB_POOL_MAX) || 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          ssl: process.env.DB_SSL === 'false' ? false : process.env.DB_SSL === 'true' ||
            (connectionString && new URL(connectionString).hostname.includes('railway') &&
              !new URL(connectionString).hostname.endsWith('.railway.internal'))
              ? { rejectUnauthorized: false } : false,
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DATABASE_TOKEN],
})
export class DatabaseModule {}
