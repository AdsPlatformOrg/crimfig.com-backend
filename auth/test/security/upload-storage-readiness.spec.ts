import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { UploadsService } from '../../../api/ads-api/src/modules/uploads/uploads.service';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
const file = { buffer: png, size: png.length, originalname: 'qa.png', mimetype: 'image/png' } as Express.Multer.File;
const asset = { id: 'asset', ownerId: 'owner', storageKey: 'photo-test.png', bytes: png.length, mimeType: 'image/png', status: 'pending' };

function setup(bucket?: any) {
  const insert = jest.fn(() => ({ values: () => ({ returning: async () => [{ ...asset, status: 'ready' }] }) }));
  const update = jest.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [{ ...asset, status: 'ready' }] }) }) }));
  const db = { insert, update, select: () => ({ from: () => ({ where: () => ({ limit: async () => [asset] }) }) }) };
  return { insert, update, service: new UploadsService(db as any, {} as any, { getBucket: () => bucket } as any) };
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
    s.insert.mockImplementation(() => { events.push('recorded'); return { values: () => ({ returning: async () => [{ ...asset, status: 'ready' }] }) }; });
    await expect(s.service.uploadDirect({ ownerId: 'owner', file })).resolves.toMatchObject({ assetId: 'asset' });
    expect(save.mock.calls[0][0]).toEqual(png);
    expect(events).toEqual(['stored', 'recorded']);
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
