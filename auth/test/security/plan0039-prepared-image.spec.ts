import sharp from "sharp";
import {
  validatePreparedImages,
  selectImageRendition,
} from "../../../api/ads-api/src/modules/uploads/prepared-image";
const manifest = {
  version: 1,
  quality: 0.97,
  profile: "standard",
  layout: "card",
  ratio: 1,
  crop: { x: 0, y: 0, width: 600, height: 600 },
};
async function file(width = 600, height = 600) {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 12, g: 80, b: 120, alpha: 0.5 },
    },
  })
    .webp({ quality: 97 })
    .toBuffer();
  return {
    buffer,
    size: buffer.length,
    mimetype: "image/webp",
    originalname: "prepared.webp",
  } as Express.Multer.File;
}
describe("prepared image validation", () => {
  it("decodes actual alpha WebP dimensions and objective byte cap", async () =>
    expect(
      (await validatePreparedImages([await file()], manifest))[0],
    ).toMatchObject({
      width: 600,
      height: 600,
      mime: "image/webp",
      cap: 150000,
    }));
  it("rejects MIME forgery, malformed image, cap overflow, ratio mismatch and low-quality manifest", async () => {
    const valid = await file();
    for (const f of [
      { ...valid, mimetype: "image/jpeg" },
      { ...valid, buffer: Buffer.from("bad"), size: 3 },
      { ...valid, buffer: Buffer.alloc(150001), size: 150001 },
      await file(600, 300),
    ])
      await expect(validatePreparedImages([f], manifest)).rejects.toThrow();
    await expect(
      validatePreparedImages([valid], { ...manifest, quality: 0.96 }),
    ).rejects.toThrow();
  });
  it("rejects EXIF data rather than retaining location metadata", async () => {
    const buffer = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "white" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 97 })
      .toBuffer();
    await expect(
      validatePreparedImages(
        [{ buffer, size: buffer.length, mimetype: "image/jpeg" } as any],
        manifest,
      ),
    ).rejects.toThrow();
  });
  it("chooses smallest compatible rendition and never widens card/banner eligibility or publisher cap", () => {
    const asset = {
      preparation: {
        layout: "card",
        renditions: [
          { url: "/large", bytes: 140000, width: 1200, height: 600 },
          { url: "/small", bytes: 48000, width: 600, height: 300 },
          { url: "/tiny", bytes: 20000, width: 200, height: 100 },
        ],
      },
    };
    expect(selectImageRendition(asset, "card", 50000)?.url).toBe("/small");
    expect(selectImageRendition(asset, "card", 40000)).toBeNull();
    expect(selectImageRendition(asset, "banner", 150000)).toBeNull();
  });
});
