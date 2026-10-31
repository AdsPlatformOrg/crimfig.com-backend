import sharp from "sharp";
import { UploadsService } from "../../../api/ads-api/src/modules/uploads/uploads.service";
const manifest = {
  version: 1,
  pipelineVersion: 2,
  quality: 0.97,
  profile: "standard",
  layout: "card",
  ratio: 1,
  crop: { x: 20, y: 20, width: 600, height: 600 },
  descriptor: {
    preset: "Square",
    rotation: 0,
    coordinateSpace: {
      width: 800,
      height: 800,
      units: "pixels",
      orientation: "exif_applied_then_rotation",
    },
  },
};
async function fixture() {
  const buffer = await sharp({
    create: {
      width: 600,
      height: 600,
      channels: 4,
      background: { r: 190, g: 25, b: 70, alpha: 0.6 },
    },
  })
    .webp({ quality: 97 })
    .toBuffer();
  return {
    buffer,
    size: buffer.length,
    mimetype: "image/webp",
    originalname: "image.webp",
  } as Express.Multer.File;
}
function setup(fail = false) {
  const outside: any[] = [],
    saved: any[] = [],
    removed: any[] = [],
    rows: any[] = [];
  let count = 0;
  const db: any = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    insert: jest.fn(() => ({
      values: (v: any) => {
        outside.push(v);
        return { returning: async () => [{ id: "outside-" + ++count, ...v }] };
      },
    })),
    transaction: async (fn: any) =>
      fn({
        insert: () => ({
          values: (values: any[]) => ({
            returning: async () => {
              if (fail) throw Error("database unavailable");
              rows.push(...values);
              return values;
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => {
              if (fail) throw Error("database unavailable");
            },
          }),
        }),
      }),
  };
  const bucket = {
    file: (key: string) => ({
      save: async (bytes: Buffer) => {
        saved.push({ key, bytes });
      },
      delete: async () => {
        removed.push(key);
      },
    }),
  };
  return {
    service: new UploadsService(
      db,
      {} as any,
      { getBucket: () => bucket } as any,
    ),
    db,
    outside,
    rows,
    saved,
    removed,
  };
}
describe("PLAN-0043 confirmed metadata persistence", () => {
  it('rejects unsupported encoder quality before storage or persistence',async()=>{
    const s=setup();await expect(s.service.uploadPrepared('owner',[await fixture()],{...manifest,quality:0.95})).rejects.toThrow();
    expect(s.saved).toHaveLength(0);expect(s.rows).toHaveLength(0);
  });
  it("does not publish incomplete rows and removes unbound objects if persistence fails", async () => {
    const s = setup(true);
    await expect(
      s.service.uploadPrepared("owner", [await fixture()], manifest),
    ).rejects.toThrow();
    expect(s.rows).toHaveLength(0);
    expect(s.removed).toHaveLength(1);
  });
  it("rejects an approved crop outside its declared source coordinate space", async () => {
    const s = setup();
    await expect(
      s.service.uploadPrepared("owner", [await fixture()], {
        ...manifest,
        crop: { x: 900, y: 0, width: 600, height: 600 },
      }),
    ).rejects.toThrow();
    expect(s.saved).toHaveLength(0);
  });
  it.each([0.97,1])('persists the validated encoder quality %s without relabeling it',async quality=>{
    const s=setup();const result:any=await s.service.uploadPrepared('owner',[await fixture()],{...manifest,quality});
    expect(result.preparation.quality).toBe(quality);expect(s.rows[0].preparation.quality).toBe(quality);
  });
  it("publishes ready assets only in the transaction containing their complete verified specs", async () => {
    const s = setup(),
      file = await fixture();
    const result: any = await s.service.uploadPrepared(
      "owner",
      [file, file],
      manifest,
    );
    expect(s.db.insert).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0]).toMatchObject({
      status: "ready",
      width: 600,
      height: 600,
      bytes: file.size,
      mimeType: "image/webp",
    });
    expect(result.preparation).toMatchObject({
      pipelineVersion: 2,
      descriptor: manifest.descriptor,
    });
    expect(result.preparation.renditions).toHaveLength(2);
    expect(result.preparation.renditions[0]).toMatchObject({
      width: 600,
      height: 600,
      mimeType: "image/webp",
      bytes: file.size,
      cap: 250000,
      target: 230000,
    });
    expect(result.preparation.renditions[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
