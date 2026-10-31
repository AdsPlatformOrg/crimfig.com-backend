jest.mock('@crimfig/shared', () => ({ FINANCIAL_SECURITY_POLICY: jest.requireActual('../../../shared/src/financial-security/policy.config').FINANCIAL_SECURITY_POLICY }));
import { BillingStaffGrants } from '../../../api/billing-api/src/modules/security/billing-staff-grants';
import { FinancialPolicyController } from '../../../api/billing-api/src/modules/security/financial-policy.controller';

describe('PLAN-0052 platform admin policy visibility', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  test('Ads grants no longer silently grant financial privileges', () => {
    const grants = new BillingStaffGrants({ get: (key: string) => key === 'ADS_STAFF_ROLE_GRANTS' ? JSON.stringify({ [id]: ['super_admin', 'ads_finance'] }) : undefined } as any);
    expect(grants.rolesFor(id)).toEqual([]);
  });
  test('Ads role names inside explicit Billing grants do not elevate privileges', () => {
    const grants = new BillingStaffGrants({ get: () => JSON.stringify({ [id]: ['ads_admin', 'ads_finance'] }) } as any);
    expect(grants.rolesFor(id)).toEqual([]);
  });
  test.each([undefined, [], ['billing_admin'], ['billing_auditor']])('denies policy disclosure to %j', roles => {
    const controller = new FinancialPolicyController({ rolesFor: () => roles || [] } as any);
    expect(() => controller.policy(roles ? { user: { sub: id } } : {})).toThrow('Platform administrator');
  });
  test('explicit platform admin can read figures but cannot activate execution', () => {
    const grants = new BillingStaffGrants({ get: () => JSON.stringify({ [id]: ['super_admin'] }) } as any);
    const result = new FinancialPolicyController(grants).policy({ user: { sub: id } });
    expect(result.data).toMatchObject({ mode: 'not_activated', executionEnabled: false, withdrawalUsdCents: 25000 });
    expect(result.data.recipients).toEqual(['jed@crimfig.com', 'jedacctwo@gmail.com']);
  });
});
