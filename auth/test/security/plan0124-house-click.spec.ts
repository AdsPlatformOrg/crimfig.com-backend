import { createHmac, randomUUID } from 'crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DeliveryService, HOUSE_CAMPAIGN_UUID, HOUSE_PLACEMENT_UUID } from '../../../api/ads-api/src/modules/delivery/delivery.service';
import { DeliveryController } from '../../../api/ads-api/src/modules/delivery/delivery.controller';
import { ImpressionTokenService } from '../../../api/ads-api/src/modules/delivery/impression-token.service';
import { AdminHouseAdsController } from '../../../api/ads-api/src/modules/delivery/admin-house-ads.controller';
import { defaultHouseDestination, parseHouseDestination, requireHouseDestination } from '../../../api/ads-api/src/modules/delivery/house-click-policy';

const signingKey='plan0124-disposable-signing-key-at-least-32';
let delivery: DeliveryService;
@Module({controllers:[DeliveryController],providers:[{provide:DeliveryService,useFactory:()=>delivery}]})
class ClickFixture {}

describe('PLAN0124 House redirects and strict token boundaries',()=>{
  let prior:NodeJS.ProcessEnv;
  beforeEach(()=>{prior={...process.env};process.env.ADS_IMPRESSION_SIGNING_KEY=signingKey;});
  afterEach(()=>{process.env=prior;jest.restoreAllMocks();});
  function setup() {
    const rows:any[]=[];
    const chain:any={from:()=>chain,where:()=>chain,limit:async()=>rows};
    const db:any={select:jest.fn(()=>chain),insert:jest.fn(),update:jest.fn()};
    const tokens=new ImpressionTokenService();
    delivery=new DeliveryService(db,tokens,{} as any,{} as any);
    const bound=jest.spyOn(delivery as any,'boundServe').mockResolvedValue(true);
    const log=jest.spyOn(delivery,'logInteraction').mockResolvedValue(undefined);
    const payload={servedId:randomUUID(),placementId:HOUSE_PLACEMENT_UUID,campaignId:HOUSE_CAMPAIGN_UUID,creativeId:randomUUID(),promoterId:randomUUID(),ipHash:tokens.hashIp('192.0.2.1')};
    return {db,tokens,bound,log,rows,payload};
  }
  test.each(['relative/path','/api/v1/delivery/go/token','javascript:alert(1)','https://user:password@example.test','https://example.test/api/v1/delivery/go/token','https://example.test/%61pi/v1/delivery/go/token'])('invalid House destinations are rejected before admin persistence: %s',destinationUrl=>{
    expect(parseHouseDestination(destinationUrl)).toBeNull();
    expect(()=>requireHouseDestination(destinationUrl)).toThrow();
  });
  test('admin rejects invalid destinations before asset reads or writes',async()=>{
    const db:any={select:jest.fn(),insert:jest.fn(),update:jest.fn()};
    const admin=new AdminHouseAdsController(db);
    await expect(admin.createHouseCreative({destinationUrl:'javascript:alert(1)'} as any,{user:{sub:randomUUID()}})).rejects.toThrow();
    await expect(admin.updateHouseCreative(randomUUID(),{destinationUrl:'/relative'} as any,{user:{sub:randomUUID()}})).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();expect(db.insert).not.toHaveBeenCalled();expect(db.update).not.toHaveBeenCalled();
  });
  test('expired paid tokens fail before telemetry, lookup or billing',async()=>{
    const f=setup();
    const clock=jest.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
    const token=f.tokens.generateToken({...f.payload,campaignId:randomUUID()});
    clock.mockReturnValue(1_800_000_000_000+59*60*1000);
    await expect(delivery.handleClick(token,'192.0.2.1')).rejects.toThrow('invalid or expired');
    expect(f.db.select).not.toHaveBeenCalled();expect(f.log).not.toHaveBeenCalled();expect(f.db.insert).not.toHaveBeenCalled();
  });
  test('unverified House marker uses only the fixed destination with no reads or telemetry',async()=>{
    const f=setup();
    const encoded=Buffer.from(JSON.stringify({...f.payload,version:2,timestamp:Date.now(),destinationUrl:'https://attacker.example'})).toString('base64url');
    const forged='imp_'+encoded+'.'+'a'.repeat(43);
    expect(await delivery.handleClick(forged,'192.0.2.1')).toBe(defaultHouseDestination());
    expect(f.db.select).not.toHaveBeenCalled();expect(f.bound).not.toHaveBeenCalled();expect(f.log).not.toHaveBeenCalled();
  });
  test('expired signed House token navigates without attribution',async()=>{
    const f=setup();f.rows.push({destination:'https://example.test/issued'});
    const clock=jest.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
    const token=f.tokens.generateToken(f.payload);
    clock.mockReturnValue(1_800_000_000_000+59*60*1000);
    expect(await delivery.handleClick(token,'192.0.2.2')).toBe('https://example.test/issued');
    expect(f.log).not.toHaveBeenCalled();
    expect(f.tokens.verifyToken(token,'192.0.2.1')).toBeNull();
    const future={...f.payload,version:2,timestamp:Date.now()+1};
    const encoded=Buffer.from(JSON.stringify(future)).toString('base64url');
    const signed='imp_'+encoded+'.'+createHmac('sha256',signingKey).update(encoded).digest('base64url');
    expect(f.tokens.verifyToken(signed,'192.0.2.1',{allowExpired:true})).toBeNull();
  });
  test('fresh custom creative survives telemetry failure and IP drift',async()=>{
    const f=setup();f.rows.push({destination:'https://example.test/custom'});
    f.log.mockRejectedValue(new Error('telemetry offline'));
    expect(await delivery.handleClick(f.tokens.generateToken(f.payload),'192.0.2.2')).toBe('https://example.test/custom');
    expect(f.log).toHaveBeenCalledTimes(1);
  });
  test('unbound and unavailable storage resolve safely without an interaction',async()=>{
    const f=setup();f.bound.mockResolvedValue(false);
    expect(await delivery.handleClick(f.tokens.generateToken(f.payload),'192.0.2.1')).toBe(defaultHouseDestination());
    expect(f.log).not.toHaveBeenCalled();
    f.bound.mockRejectedValue(new Error('database offline'));
    expect(await delivery.handleClick(f.tokens.generateToken(f.payload),'192.0.2.1')).toBe(defaultHouseDestination());
  });
  test('production destinations require HTTPS',()=>{
    process.env.NODE_ENV='production';
    expect(parseHouseDestination('http://example.test')).toBeNull();
    expect(parseHouseDestination('https://example.test')).toBe('https://example.test/');
  });
  test('signing key rotation preserves only the fixed safe fallback without reads or telemetry',async()=>{
    const f=setup(),token=f.tokens.generateToken(f.payload);
    process.env.ADS_IMPRESSION_SIGNING_KEY='rotated-disposable-key-at-least-32-bytes';
    expect(await delivery.handleClick(token,'192.0.2.1')).toBe(defaultHouseDestination());
    expect(f.db.select).not.toHaveBeenCalled();expect(f.log).not.toHaveBeenCalled();
  });
  test('pruned serve recovers a valid signed creative destination and sanitizes invalid legacy URLs',async()=>{
    const f=setup();f.bound.mockResolvedValue(false);f.rows.push({destination:'https://example.test/safe'});
    const token=f.tokens.generateToken(f.payload);
    expect(await delivery.handleClick(token,'192.0.2.1')).toBe('https://example.test/safe');
    f.rows[0]={destination:'javascript:alert(1)'};
    expect(await delivery.handleClick(token,'192.0.2.1')).toBe(defaultHouseDestination());
    expect(f.log).not.toHaveBeenCalled();
  });
  test('the public HTTP route returns 302 for expired House tokens and 404 for paid tokens',async()=>{
    const f=setup();f.rows.push({destination:'https://example.test/house'});
    const clock=jest.spyOn(Date,'now').mockReturnValue(1_800_000_000_000);
    const house=f.tokens.generateToken(f.payload),paid=f.tokens.generateToken({...f.payload,campaignId:randomUUID()});
    clock.mockReturnValue(1_800_000_000_000+59*60*1000);
    const app=await NestFactory.create(ClickFixture,{logger:false});
    app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
    try {
      const origin=await app.getUrl();
      const a=await fetch(origin+'/api/v1/delivery/go/'+house,{redirect:'manual'});
      expect(a.status).toBe(302);expect(a.headers.get('location')).toBe('https://example.test/house');
      const b=await fetch(origin+'/api/v1/delivery/go/'+paid,{redirect:'manual'});
      expect(b.status).toBe(404);
      expect(f.log).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
});
