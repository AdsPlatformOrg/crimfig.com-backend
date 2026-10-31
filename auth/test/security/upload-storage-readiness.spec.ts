import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { UploadsService } from '../../../api/ads-api/src/modules/uploads/uploads.service';
import * as schema from '@crimfig/database/schema';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
const file = { buffer: png, size: png.length, originalname: 'qa.png', mimetype: 'image/png' } as Express.Multer.File;
const asset = { id: 'asset', ownerId: 'owner', storageKey: 'photo-test.png', bytes: png.length, mimeType: 'image/png', status: 'pending' };

function setup(bucket?: any) {
  const insert = jest.fn(() => ({ values: () => ({ returning: async () => [{ ...asset, status: 'ready' }], onConflictDoNothing:async()=>{} }) }));
  const update = jest.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [{ ...asset, status: 'ready' }] }) }) }));
  const db = { insert, update, select: () => ({ from: () => ({ where: () => ({ limit: async () => [asset] }) }) }) };
  const router={isConfigured:()=>!!bucket,getPrimaryAdapter:()=>({provider:'firebase'}),putObject:async(input:any)=>bucket.file(input.key).save(input.body,{contentType:input.contentType}),statObject:async(key:string)=>{if(!bucket)return null;const ref=bucket.file(key);const [exists]=await ref.exists();if(!exists)return null;const [meta]=await ref.getMetadata();return{bytes:Number(meta.size),contentType:meta.contentType};}};
  return { insert, update, service: new UploadsService(db as any, {} as any, { getBucket: () => bucket } as any,router as any) };
}

describe('uploaded assets require actual storage', () => {
  it('direct upload fails without storage and never records a ready asset', async () => {
    const s = setup();
    await expect(s.service.uploadDirect({ ownerId: 'owner', file })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('presign fails without storage and never fabricates a signed URL or pending row', async () => {
    const s = setup();
    await expect(s.service.presign({ ownerId: 'owner', fileName: 'qa.png', contentType: 'image/png', contentLength: png.length })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('a failed bucket write never records success', async () => {
    const s = setup({ file: () => ({ save: async () => { throw Error('bucket write failed'); } }) });
    await expect(s.service.uploadDirect({ ownerId: 'owner', file })).rejects.toThrow('bucket write failed');
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('writes the actual file before recording the ready asset', async () => {
    const events: string[] = [];
    const save = jest.fn(async (_buffer: Buffer, _options: unknown) => { events.push('stored'); });
    const s = setup({ file: () => ({ save }) });
    s.insert.mockImplementation(() => { events.push('recorded'); return { values: () => ({ returning: async () => [{ ...asset, status: 'ready' }], onConflictDoNothing:async()=>{} }) }; });
    await expect(s.service.uploadDirect({ ownerId: 'owner', file })).resolves.toMatchObject({ assetId: 'asset' });
    expect(save.mock.calls[0][0]).toEqual(png);
    expect(events).toEqual(['stored', 'recorded', 'recorded']);
  });

  it('completion requires storage and an uploaded object matching expected size and type', async () => {
    const unavailable = setup();
    await expect(unavailable.service.complete({ assetId: 'asset', ownerId: 'owner' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(unavailable.update).not.toHaveBeenCalled();
    for (const [exists, size, contentType] of [[false, png.length, 'image/png'], [true, 1, 'image/png'], [true, png.length, 'video/mp4']]) {
      const s = setup({ file: () => ({ exists: async () => [exists], getMetadata: async () => [{ size, contentType }] }) });
      await expect(s.service.complete({ assetId: 'asset', ownerId: 'owner' })).rejects.toBeInstanceOf(BadRequestException);
      expect(s.update).not.toHaveBeenCalled();
    }
  });

  it('valid completed object can become ready', async () => {
    const s = setup({ file: () => ({ exists: async () => [true], getMetadata: async () => [{ size: png.length, contentType: 'image/png' }] }) });
    await expect(s.service.complete({ assetId: 'asset', ownerId: 'owner' })).resolves.toMatchObject({ status: 'ready' });
    expect(s.update).toHaveBeenCalledTimes(1);
  });
});
describe('House public media remains explicitly bound',()=>{
 function publicAsset(houseAllowed:boolean){const queryFor=(table:any)=>{const rows=table===schema.adsMediaAssets?[{...asset,status:'ready'}]:table===schema.adsHouseCreatives&&houseAllowed?[{id:'house'}]:[];const q:any={innerJoin:()=>q,where:()=>q,limit:async()=>rows};return q;};const router={isConfigured:()=>true,statObject:jest.fn(async()=>({bytes:png.length,contentType:'image/png'})),getObjectStream:jest.fn(async()=>({stream:'stream',contentType:'image/png',contentLength:10,totalSize:png.length}))};const db={select:()=>({from:queryFor})};return{router,service:new UploadsService(db as any,{} as any,{} as any,router as any)};}
 it('does not publish a private upload without an approved campaign or active House binding',async()=>{const f=publicAsset(false);await expect(f.service.getMediaStream('photo-test.png')).rejects.toThrow('Public media asset not found');expect(f.router.getObjectStream).not.toHaveBeenCalled();});
 it('rejects invalid ranges without opening a stream',async()=>{const f=publicAsset(true);await expect(f.service.getMediaStream('photo-test.png',undefined,false,{start:999999})).resolves.toMatchObject({rangeInvalid:true});expect(f.router.getObjectStream).not.toHaveBeenCalled();});
 it('streams bound House media through the configured router rather than assuming Firebase',async()=>{const f=publicAsset(true);const result=await f.service.getMediaStream('photo-test.png',undefined,false,{start:0,end:9});expect(result).toMatchObject({stream:'stream',partial:true,contentLength:10});expect(f.router.getObjectStream).toHaveBeenCalledWith('photo-test.png',{start:0,end:9});});
});
