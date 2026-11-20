import {BadRequestException} from '@nestjs/common';
import {AdsOperationsService} from '../../../api/ads-api/src/modules/ads-operations/ads-operations.service';
describe('PLAN0080 website review negative-first units',()=>{
 test.each(['invalid',true,null,{}])('invalid decision %s rejects before any database call',async decision=>{const db:any={transaction:jest.fn()};await expect(new AdsOperationsService(db).reviewWebsitePolicy('site',decision as any,'Reason','staff')).rejects.toThrow(BadRequestException);expect(db.transaction).not.toHaveBeenCalled();});
 test.each(['x'.repeat(1001),{}])('invalid reason rejects before any database call',async reason=>{const db:any={transaction:jest.fn()};await expect(new AdsOperationsService(db).reviewWebsitePolicy('site','approved',reason as any,'staff')).rejects.toThrow(BadRequestException);expect(db.transaction).not.toHaveBeenCalled();});
 test.each([null,new Date(0)])('expired or absent ownership proof cannot approve',async expiry=>{const tx:any={execute:jest.fn(),select:()=>({from:()=>({where:()=>({for:()=>({limit:async()=>[{id:'site',verificationStatus:'verified',verificationExpiresAt:expiry}]})})})}),update:jest.fn(),insert:jest.fn()};const db:any={transaction:(run:any)=>run(tx)};await expect(new AdsOperationsService(db).reviewWebsitePolicy('site','approved','Real fixture reason','staff')).rejects.toThrow(/unexpired/);expect(tx.update).not.toHaveBeenCalled();expect(tx.insert).not.toHaveBeenCalled();});
});

test('PLAN0121 a stale policy revision cannot deactivate a website', async () => {
  const tx = {
    execute: jest.fn(),
    select: () => ({ from: () => ({ where: () => ({ for: () => ({
      limit: async () => [{ id: 'site', policyRevision: 3 }],
    }) }) }) }),
    update: jest.fn(),
    insert: jest.fn(),
  };
  const db = { transaction: (run: (transaction: typeof tx) => unknown) => run(tx) };
  await expect(new AdsOperationsService(db as any)
    .reviewWebsitePolicy('site', 'suspended', 'Fixture review reason', 'staff', 2)).rejects.toThrow(/changed/);
  expect(tx.update).not.toHaveBeenCalled();
  expect(tx.insert).not.toHaveBeenCalled();
});

describe('PLAN0122 website directory sort', () => {
  test.each([
    ['__proto__', 'asc'],
    ['domain', 'invalid'],
    ['unknown', 'desc'],
  ])('rejects unsupported sort %s / %s before opening a transaction', async (sortBy, direction) => {
    const db = { transaction: jest.fn() };
    await expect(new AdsOperationsService(db as any).adminListWebsites(
      1, 25, undefined, undefined, undefined, sortBy, direction,
    )).rejects.toThrow('Invalid website sort parameters');
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
