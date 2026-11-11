import { reportRange, addReportMetrics, emptyReportMetrics } from '../../../api/ads-api/src/modules/analytics/report-range';

describe('PLAN0102 report dates and precision', () => {
  const now = new Date('2026-11-10T23:15:00Z');
  it('rejects impossible, inverted, future and oversized ranges', () => {
    for (const [from, to] of [
      ['2026-02-30', '2026-03-01'], ['2026-11-11', '2026-11-10'],
      ['2026-11-11', '2026-11-12'], ['2026-01-01', '2026-11-11'],
    ]) expect(() => reportRange(from, to, now)).toThrow();
  });
  it('defaults to completed Lagos days and compares an equal preceding period', () => {
    expect(reportRange(undefined, undefined, now)).toMatchObject({
      today: '2026-11-11', from: '2026-11-04', to: '2026-11-10',
      until: '2026-11-11', previousFrom: '2026-10-28', previousTo: '2026-11-03',
    });
  });
  it('sums nanos beyond JavaScript safe-integer precision and keeps debits separate', () => {
    const total = { ...emptyReportMetrics(), spend: '9007199254740992' };
    addReportMetrics(total, { ...emptyReportMetrics(), spend: '500000', posted: '10000000' });
    expect(total).toMatchObject({ spend: '9007199255240992', posted: '10000000' });
  });
});
