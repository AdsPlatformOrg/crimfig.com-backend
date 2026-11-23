jest.mock('@crimfig/shared',()=>({FINANCIAL_SECURITY_POLICY:jest.requireActual('../../../shared/src/financial-security/policy.config').FINANCIAL_SECURITY_POLICY}));
import { BillingStaffGrants } from '../../../api/billing-api/src/modules/security/billing-staff-grants';
import { FinancialPolicyController } from '../../../api/billing-api/src/modules/security/financial-policy.controller';
import { grantFixture } from './platform-grant-fixture';
describe('PLAN0052 database-backed platform policy visibility',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 it('does not accept Ads role names as Billing authority',async()=>{
  await expect(new BillingStaffGrants(grantFixture({[id]:['ads_admin','ads_finance']})).rolesFor(id)).resolves.toEqual([]);
 });
 it.each([undefined,[],['billing_admin'],['billing_auditor']])('denies policy disclosure to %j',async roles=>{
  const controller=new FinancialPolicyController({rolesFor:async()=>roles||[]} as any);
  await expect(controller.policy(roles?{user:{sub:id}}:{})).rejects.toThrow('Platform administrator');
 });
 it('allows an explicit scoped database grant without activating execution',async()=>{
  const controller=new FinancialPolicyController(new BillingStaffGrants(grantFixture({[id]:['super_admin']})));
  expect((await controller.policy({user:{sub:id}})).data).toMatchObject({mode:'not_activated',executionEnabled:false,withdrawalUsdCents:25000});
 });
});
