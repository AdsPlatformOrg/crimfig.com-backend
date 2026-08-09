import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@crimfig/database/schema';
import { config } from '../../config/config';

const DATABASE_TOKEN = 'DATABASE';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_TOKEN,
      useFactory: () => {
        const pool = new Pool({
          host: config.DB.HOST,
          port: config.DB.PORT,
          database: config.DB.NAME,
          user: config.DB.USER,
          password: config.DB.PASSWORD,
          ssl: config.DB.SSL ? { rejectUnauthorized: true } : false,
          max: 20,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        return drizzle(pool, { schema, logger: config.IS_DEVELOPMENT });
      },
    },
  ],
  exports: [DATABASE_TOKEN],
})
export class DatabaseModule {}

export { DATABASE_TOKEN };
