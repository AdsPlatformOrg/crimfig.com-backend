import sharp from 'sharp';
import {validatePreparedImages} from '../../../api/ads-api/src/modules/uploads/prepared-image';
import {CampaignsService} from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
const manifest={version:1,quality:1,profile:'standard',layout:'card',ratio:1,crop:{x:0,y:0,width:600,height:600}};
async function image(bytes?:number) {
  const encoded=await sharp({create:{width:600,height:600,channels:3,background:'white'}}).webp({quality:100}).toBuffer();
  const buffer=bytes?Buffer.concat([encoded,Buffer.alloc(bytes-encoded.length)]):encoded;
  return {buffer,size:buffer.length,mimetype:'image/webp',originalname:'prepared.webp'} as Express.Multer.File;
}
describe('PLAN-0051 delivered byte and campaign attachment boundaries — failures first',()=>{
  it.each([['compact',100000],['standard',250000],['larger',300000]] as const)('rejects %s cap + 1 before decoding',async(profile,cap)=>{
    await expect(validatePreparedImages([await image(cap+1)],{...manifest,profile})).rejects.toThrow('byte cap');
  });
  it('rejects secondary rendition overflow, forged byte counts and unsupported quality',async()=>{
    const valid=await image();
    await expect(validatePreparedImages([valid,await image(100001)],manifest)).rejects.toThrow('byte cap');
    await expect(validatePreparedImages([{...valid,size:valid.size+1}],manifest)).rejects.toThrow('byte cap');
    for(const quality of [0,0.95,1.01,'1',null])await expect(validatePreparedImages([valid],{...manifest,quality})).rejects.toThrow('settings');
  });
  it('campaign attachment rejects over-cap, foreign and unready media without writing',async()=>{
    let asset:any={id:'asset',bytes:300001,cdnUrl:'/image.webp',mimeType:'image/webp',preparation:{layout:'card'},width:600,height:600};
    const q:any={from:()=>q,where:()=>q,limit:async()=>asset?[asset]:[]};
    const db:any={select:()=>q,insert:jest.fn(),update:jest.fn()};
    const service=new CampaignsService(db,{} as any,{} as any);
    const input={adType:'image',mediaAssetId:'asset',destinationUrl:'https://example.com',adFormat:'card'};
    await expect((service as any).validateCreative(db,'owner',input)).rejects.toThrow('300 KB');
    asset=null;await expect((service as any).validateCreative(db,'owner',input)).rejects.toThrow('not owned');
    expect(db.insert).not.toHaveBeenCalled();expect(db.update).not.toHaveBeenCalled();
  });
  it.each([['compact',100000],['standard',250000],['larger',300000]] as const)('accepts a decoded %s file at the exact byte cap',async(profile,cap)=>{
    const result=await validatePreparedImages([await image(cap)],{...manifest,profile});expect(result[0].cap).toBe(cap);expect(result[0].file.size).toBe(cap);
  });
  it.each([0.97,1])('keeps legacy and current quality %s valid',async quality=>{
    await expect(validatePreparedImages([await image()],{...manifest,quality})).resolves.toHaveLength(1);
  });
  it.each([200001,250000,300000])('attaches a ready image of %s bytes using the new supported boundary',async bytes=>{
    const asset={id:'asset',bytes,cdnUrl:'/image.webp',mimeType:'image/webp',preparation:{layout:'card'},width:600,height:600};
    const q:any={from:()=>q,where:()=>q,limit:async()=>[asset]};
    const db:any={select:()=>q};const service=new CampaignsService(db,{} as any,{} as any);
    await expect((service as any).validateCreative(db,'owner',{adType:'image',mediaAssetId:'asset',destinationUrl:'https://example.com',adFormat:'card'})).resolves.toMatchObject({mediaAssetId:'asset',imageUrl:'/image.webp'});
  });
});
