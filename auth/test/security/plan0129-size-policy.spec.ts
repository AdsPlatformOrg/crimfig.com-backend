import {validateCreativeSizePolicy,intersectCreativeSlotSizes} from '../../../api/ads-api/src/modules/uploads/creative-size-policy';
import {PublisherSlotsService} from '../../../api/ads-api/src/modules/publisher-inventory/publisher-slots.service';
import {ManagedCreateSlotDto,ManagedUpdateSlotDto} from '../../../api/ads-api/src/modules/publisher-inventory/publisher-inventory.controller';
import {validate} from 'class-validator';
describe('PLAN0129 size policy and mutation boundaries',()=>{
  const asset={width:300,height:250,bytes:90000};
  test('managed slot DTOs reject invalid dimensions and accept clearing saved limits',async()=>{
    for(const width of [-1,0,49,3841,12.5]){
      const errors=await validate(Object.assign(new ManagedCreateSlotDto(),{requestId:'00000000-0000-4000-8000-000000000001',websiteId:'00000000-0000-4000-8000-000000000002',name:'Slot',slotType:'network',width}));
      expect(errors.some(error=>error.property==='width')).toBe(true);
    }
    const errors=await validate(Object.assign(new ManagedUpdateSlotDto(),{requestId:'00000000-0000-4000-8000-000000000001',expectedUpdatedAt:'2026-11-21T00:00:00.000Z',width:null,height:null}));
    expect(errors).toHaveLength(0);
  });
  test('invalid and unavailable sizes fail without widening eligibility',()=>{
    for(const [policy,ids] of [['invalid',[]],['single',[]],['single',['medium_rectangle','square']],['dynamic',['square']],['selected',['unapproved']],['single',['leaderboard']]])expect(()=>validateCreativeSizePolicy(policy,ids,asset)).toThrow();
    expect(()=>validateCreativeSizePolicy('dynamic',[],{...asset,bytes:250001})).toThrow();
    expect(intersectCreativeSlotSizes({allowedPresetIds:'invalid'},'selected','["square"]')).toBeNull();
    expect(intersectCreativeSlotSizes({allowedPresetIds:'["square"]'},'single','["leaderboard"]')).toBeNull();
  });
  test('invalid mutation controls and empty names perform no database work',async()=>{
    const db:any={transaction:jest.fn()},service=new PublisherSlotsService(db);
    await expect(service.managedMutation('owner','create',undefined,{requestId:'invalid'})).rejects.toThrow();
    await expect(service.managedMutation('owner','create',undefined,{requestId:'00000000-0000-4000-8000-000000000001',name:'   '})).rejects.toThrow();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  test('Dynamic uses actual compatible renditions; restrictions intersect with the slot',()=>{
    expect(validateCreativeSizePolicy(undefined,undefined,asset)).toEqual({sizePolicy:'dynamic',allowedPresetIds:null});
    expect(validateCreativeSizePolicy('single',['medium_rectangle'],asset)).toEqual({sizePolicy:'single',allowedPresetIds:'["medium_rectangle"]'});
    expect(validateCreativeSizePolicy('legacy',undefined,{})).toEqual({sizePolicy:'legacy',allowedPresetIds:null});
    expect(intersectCreativeSlotSizes({width:320,allowedPresetIds:'["square","medium_rectangle"]'},'selected','["medium_rectangle","leaderboard"]')).toEqual({width:320,allowedPresetIds:'["medium_rectangle"]'});
  });
});
