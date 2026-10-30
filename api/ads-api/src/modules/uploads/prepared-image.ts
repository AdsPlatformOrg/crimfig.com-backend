import sharp from "sharp";
export const IMAGE_PROFILES = {
  compact: { target: 80000, cap: 100000 },
  standard: { target: 230000, cap: 250000 },
  larger: { target: 280000, cap: 300000 },
} as const;
export async function validatePreparedImages(
  files: Express.Multer.File[],
  manifest: any,
) {
  if (
    !manifest ||
    manifest.version !== 1 ||
    (manifest.quality !== 1.0 && manifest.quality !== 0.97) ||
    !["card", "banner"].includes(manifest.layout) ||
    !IMAGE_PROFILES[manifest.profile as keyof typeof IMAGE_PROFILES]
  )
    throw Error("Invalid image preparation settings.");
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 3 ||
    files.reduce((n, f) => n + f.size, 0) > 700000
  )
    throw Error("Upload one to three prepared images, at most 700 KB total.");
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
  if (
    manifest.pipelineVersion !== undefined &&
    ![1, 2].includes(manifest.pipelineVersion)
  )
    throw Error("Unsupported image pipeline version.");
  if (manifest.pipelineVersion === 2) validatePreparationDescriptor(manifest);
  const output: Array<{
    file: Express.Multer.File;
    width: number;
    height: number;
    mime: string;
    cap: number;
  }> = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const cap =
      i === 0
        ? IMAGE_PROFILES[manifest.profile as keyof typeof IMAGE_PROFILES].cap
        : 100000;
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

/** Only explicit processing data is retained; arbitrary source metadata is discarded. */
export function validatePreparationDescriptor(manifest: any) {
  const d = manifest.descriptor,
    c = manifest.crop,
    space = d?.coordinateSpace;
  if (
    !d ||
    typeof d.preset !== "string" ||
    !d.preset.trim() ||
    d.preset.length > 80 ||
    ![0, 90, 180, 270].includes(d.rotation) ||
    !space ||
    space.units !== "pixels" ||
    space.orientation !== "exif_applied_then_rotation" ||
    ![space.width, space.height].every(
      (v) => Number.isInteger(v) && v > 0 && v <= 2048,
    ) ||
    c.x + c.width > space.width + 0.01 ||
    c.y + c.height > space.height + 0.01 ||
    Math.abs(c.width - c.height * manifest.ratio) > 0.01
  )
    throw Error(
      "The approved crop does not match its source coordinate space.",
    );
  const custom = d.customRatio;
  if (
    custom &&
    (![custom.width, custom.height].every(
      (v) => Number.isFinite(v) && v > 0 && v <= 100000,
    ) ||
      Math.abs(custom.width / custom.height - manifest.ratio) > 0.02)
  )
    throw Error("Invalid custom crop ratio.");
  const source = d.source;
  if (
    source &&
    (![source.width, source.height, source.bytes].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
      source.width * source.height > 24000000 ||
      Math.max(source.width, source.height) > 16384 ||
      source.bytes > 100000000 ||
      source.reportedBy !== "client")
  )
    throw Error("Invalid client-reported source dimensions.");
  return {
    preset: d.preset,
    rotation: d.rotation,
    coordinateSpace: {
      width: space.width,
      height: space.height,
      units: "pixels",
      orientation: "exif_applied_then_rotation",
    },
    ...(custom
      ? { customRatio: { width: custom.width, height: custom.height } }
      : {}),
    ...(source
      ? {
          source: {
            width: source.width,
            height: source.height,
            bytes: source.bytes,
            reportedBy: "client",
          },
        }
      : {}),
  };
}
export function imageSpecsView(asset: any) {
  return {
    width: asset.width,
    height: asset.height,
    bytes: Number(asset.bytes),
    mimeType: asset.mimeType,
    sha256: asset.sha256,
    preparation: asset.preparation ?? null,
  };
}
