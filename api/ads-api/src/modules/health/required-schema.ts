import { requireServiceSchema } from '@crimfig/database/schema';
import { sql } from 'drizzle-orm';

export async function requiredAdsSchema(db: { execute: (query: any) => Promise<any> }) {
  await requireServiceSchema(db, 'ads');
  const result = await db.execute(sql`
    SELECT to_regclass('public.report_access_audit') IS NOT NULL
      AND to_regclass('public.report_access_alerts') IS NOT NULL AS ready
  `);
  if ((result.rows ?? result)[0]?.ready !== true) {
    throw new Error('Required report access audit schema unavailable');
  }
}
