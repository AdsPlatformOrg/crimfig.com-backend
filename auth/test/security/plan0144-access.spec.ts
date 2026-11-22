import { reportAction, reportScope } from '../../../api/ads-api/src/modules/report-access/report-audit.service';
import { AdminReportsController } from '../../../api/ads-api/src/modules/report-access/reports.controller';

describe('PLAN0144 report audit scope', () => {
  it('omits raw searches, contacts, invalid IDs and unapproved reasons', () => {
    const scope = reportScope({ path: '/api/v1/admin/reports/contacts', query: { search: 'private@example.test', from: 'private@example.test', website: 'invalid', role: 'admin' }, body: { reason: 'private@example.test' } });
    expect(scope).toEqual({ operation: 'masked_contacts' });
  });
  it('recognizes alternate route casing and keeps only bounded scope fields', () => {
    expect(reportAction('/API/V1/REPORTS/DAILY')).toBe('report.daily');
    expect(reportAction('/api/v1/admin/ads/click-audit')).toBe('report.click-audit');
    expect(reportAction('/api/v1/campaigns')).toBeNull();
    expect(reportScope({ path: '/api/v1/admin/reports/contacts/x/reveal', params: { userId: '00000000-0000-4000-8000-000000000001' }, body: { field: 'phone' } }))
      .toEqual({ operation: 'contact_reveal', target: '00000000-0000-4000-8000-000000000001', field: 'phone' });
  });
  it('rejects malformed pages, dates and reveal bodies before data reads', async () => {
    const db = { execute: jest.fn() };
    const controller = new AdminReportsController(db as any);
    await expect(controller.contacts('-1')).rejects.toThrow('Invalid page');
    await expect(controller.delivery(['2026-11-20'] as any)).rejects.toThrow('Invalid report dates');
    await expect(controller.reveal('invalid', { field: 'password', reason: 'anything' })).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
