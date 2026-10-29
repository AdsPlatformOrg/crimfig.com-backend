import sharp from "sharp";
export const IMAGE_PROFILES = {
  compact: { target: 40000, cap: 50000 },
  standard: { target: 100000, cap: 150000 },
  larger: { target: 150000, cap: 200000 },
} as const;
export async function validatePreparedImages(
  files: Express.Multer.File[],
  manifest: any,
) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.quality !== 0.97 ||
    !["card", "banner"].includes(manifest.layout) ||
    !IMAGE_PROFILES[manifest.profile as keyof typeof IMAGE_PROFILES]
  )
    throw Error("Invalid image preparation settings.");
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 3 ||
    files.reduce((n, f) => n + f.size, 0) > 450000
  )
    throw Error("Upload one to three prepared images, at most 450 KB total.");
  if (
    !Number.isFinite(manifest.ratio) ||
    manifest.ratio <= 0 ||
    manifest.ratio > 50
  )
    throw Error("Invalid crop ratio.");
  const crop = manifest.crop;
  if (
    !crop ||
    !["x", "y", "width", "height"].every(
      (k) => Number.isFinite(crop[k]) && crop[k] >= 0,
    ) ||
    !crop.width ||
    !crop.height
  )
    throw Error("Invalid approved crop.");
  const output: Array<{file:Express.Multer.File;width:number;height:number;mime:string;cap:number}> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const cap =
      i === 0
        ? IMAGE_PROFILES[manifest.profile as keyof typeof IMAGE_PROFILES].cap
        : 50000;
    if (f.size !== f.buffer.length || !f.size || f.size > cap)
      throw Error("Prepared image exceeds its delivered byte cap.");
    const image = sharp(f.buffer, {
      limitInputPixels: 4194304,
      failOn: "warning",
      animated: true,
    });
    const meta = await image.metadata();
    const mime = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(mime) ||
      f.mimetype !== mime ||
      (meta.pages ?? 1) !== 1 ||
      !meta.width ||
      !meta.height ||
      meta.width > 2048 ||
      meta.height > 2048
    )
      throw Error("Use a valid static JPEG, PNG or WebP prepared image.");
    if (
      Math.abs(meta.width - meta.height * manifest.ratio) >
      Math.max(2, manifest.ratio)
    )
      throw Error("Rendition ratio does not match the approved crop.");
    if (meta.exif || meta.icc || meta.xmp || meta.iptc || meta.orientation)
      throw Error("Prepared images must not include source metadata.");
    await image.stats(); // Validate decoding too; never re-encode or change quality.
    output.push({ file: f, width: meta.width, height: meta.height, mime, cap });
  }
  return output;
}

/** Smallest valid rendition, with no stretching, format widening or over-cap fallback. */
export function selectImageRendition(asset: any, layout: string, cap: number) {
  const preparation = asset.preparation;
  if (preparation && preparation.layout !== layout) return null;
  const choices = preparation?.renditions ?? [
    {
      url: asset.imageUrl,
      bytes: Number(asset.imageBytes),
      width: asset.width,
      height: asset.height,
    },
  ];
  const minimum =
    layout === "banner"
      ? { width: 320, height: 50 }
      : { width: 300, height: 150 };
  return (
    choices
      .filter(
        (r: any) =>
          typeof r.url === "string" &&
          Number.isSafeInteger(r.bytes) &&
          r.bytes > 0 &&
          r.bytes <= cap &&
          r.width >= minimum.width &&
          r.height >= minimum.height,
      )
      .sort((a: any, b: any) => a.bytes - b.bytes)[0] ?? null
  );
}
