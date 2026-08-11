import { Pool } from 'pg';
import * as schema from '../schema';
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: Pool;
};
export declare function checkDatabaseConnection(): Promise<boolean>;
export { schema };
//# sourceMappingURL=index.d.ts.map