import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { config } from '../../config/config';

export const DATABASE_TOKEN = 'DATABASE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_TOKEN,
      useFactory: (): NodePgDatabase<typeof schema> => {
        const pool = new Pool({
          host: config.DB.HOST,
          port: config.DB.PORT,
          database: config.DB.NAME,
          user: config.DB.USER,
          password: config.DB.PASSWORD,
          max: config.DB.POOL_MAX,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          ssl: config.DB.SSL ? { rejectUnauthorized: false } : false,
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DATABASE_TOKEN],
})
export class DatabaseModule {}
