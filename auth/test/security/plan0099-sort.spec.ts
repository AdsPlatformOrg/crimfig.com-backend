import { BadRequestException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { campaignListOrder, CAMPAIGN_LIST_SORTS } from '../../../api/ads-api/src/modules/campaigns/campaign-list-sort';

describe('PLAN0099 campaign sort allowlist', () => {
  test('rejects unsupported expressions instead of interpolating client SQL', () => {
    for (const value of ['', 'title; drop table users', 'budget desc', 'toString', null, 42]) {
      expect(() => campaignListOrder(value as any)).toThrow(BadRequestException);
    }
  });

  test('every documented sort compiles with a fixed direction and bound metric values', () => {
    const dialect = new PgDialect();
    for (const sort of CAMPAIGN_LIST_SORTS) {
      const query = dialect.sqlToQuery(campaignListOrder(sort));
      expect(query.sql.endsWith(sort === 'newest' || sort.endsWith('_desc') ? ' desc' : ' asc')).toBe(true);
      if (/views|clicks|ctr/.test(sort)) {
        expect(query.sql).toContain('"ads_interactions"."is_valid" = true');
        expect(query.sql).toContain('END = "ads_campaigns"."id"');
        expect(query.sql).toContain('"ads_serves"."inventory_class"');
        expect(query.params).toContain(sort.startsWith('views') ? 'impression' : 'click');
      }
    }
  });
});
