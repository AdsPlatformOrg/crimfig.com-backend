import { requireServiceSchema } from '@crimfig/database/schema';

export async function requiredAdsSchema(db: { execute: (query: any) => Promise<any> }) {
  await requireServiceSchema(db, 'ads');
}
