import { ProviderApprovalGate } from '../../../shared/src/financial-security/provider-approval';
describe('provider approval callback admission',()=>{
  test('unreleased execution rejects callbacks without touching storage',async()=>{
    const store={transaction:jest.fn()}, health=jest.fn();
    expect(await new ProviderApprovalGate(store as any,{},health).approve('test',{reference:'wd_'+'a'.repeat(40),amount:100})).toBe(false);
    expect(store.transaction).not.toHaveBeenCalled();expect(health).not.toHaveBeenCalled();
  });
});
