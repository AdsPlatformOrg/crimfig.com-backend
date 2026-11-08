/**
 * PLAN-0067: Canonical Image Ad Presets and Responsive Compatibility Registry
 *
 * Exactly nine approved image display presets for CrimFig Ads.
 * Ratios are represented in their mathematically reduced integer form (numerator/denominator).
 * 600x600 is treated as a high-resolution source for square renditions, not a tenth preset.
 */

export interface ImageAdPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  ratioNumerator: number;
  ratioDenominator: number;
  ratioDecimal: number;
  priority: 'initial' | 'high' | 'required';
  category: 'rectangle' | 'banner' | 'square' | 'vertical' | 'large_display';
}

export const APPROVED_IMAGE_AD_PRESETS: readonly ImageAdPreset[] = [
  {
    id: 'medium_rectangle',
    name: 'Medium Rectangle',
    width: 300,
    height: 250,
    ratioNumerator: 6,
    ratioDenominator: 5,
    ratioDecimal: 1.2,
    priority: 'initial',
    category: 'rectangle',
  },
  {
    id: 'large_rectangle',
    name: 'Large Rectangle',
    width: 336,
    height: 280,
    ratioNumerator: 6,
    ratioDenominator: 5,
    ratioDecimal: 1.2,
    priority: 'required',
    category: 'rectangle',
  },
  {
    id: 'leaderboard',
    name: 'Leaderboard',
    width: 728,
    height: 90,
    ratioNumerator: 364,
    ratioDenominator: 45,
    ratioDecimal: 728 / 90,
    priority: 'initial',
    category: 'banner',
  },
  {
    id: 'mobile_banner',
    name: 'Mobile Banner',
    width: 320,
    height: 50,
    ratioNumerator: 32,
    ratioDenominator: 5,
    ratioDecimal: 6.4,
    priority: 'initial',
    category: 'banner',
  },
  {
    id: 'large_mobile_banner',
    name: 'Large Mobile Banner',
    width: 320,
    height: 100,
    ratioNumerator: 16,
    ratioDenominator: 5,
    ratioDecimal: 3.2,
    priority: 'required',
    category: 'banner',
  },
  {
    id: 'half_page',
    name: 'Half Page',
    width: 300,
    height: 600,
    ratioNumerator: 1,
    ratioDenominator: 2,
    ratioDecimal: 0.5,
    priority: 'required',
    category: 'vertical',
  },
  {
    id: 'billboard',
    name: 'Billboard',
    width: 970,
    height: 250,
    ratioNumerator: 97,
    ratioDenominator: 25,
    ratioDecimal: 3.88,
    priority: 'required',
    category: 'large_display',
  },
  {
    id: 'square',
    name: 'Square',
    width: 250,
    height: 250,
    ratioNumerator: 1,
    ratioDenominator: 1,
    ratioDecimal: 1.0,
    priority: 'high',
    category: 'square',
  },
  {
    id: 'large_square',
    name: 'Large Square',
    width: 300,
    height: 300,
    ratioNumerator: 1,
    ratioDenominator: 1,
    ratioDecimal: 1.0,
    priority: 'high',
    category: 'square',
  },
] as const;

export const IMAGE_AD_PRESET_MAP: Readonly<Record<string, ImageAdPreset>> = Object.freeze(
  APPROVED_IMAGE_AD_PRESETS.reduce((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, {} as Record<string, ImageAdPreset>)
);

export const APPROVED_IMAGE_PRESET_IDS: readonly string[] = Object.freeze(
  APPROVED_IMAGE_AD_PRESETS.map((p) => p.id)
);

export const CURRENT_IMAGE_PRESETS_POLICY_VERSION = 1;

/**
 * Validates if a preset ID is one of the exactly 9 approved presets.
 */
export function isApprovedImagePreset(presetId: string): boolean {
  return typeof presetId === 'string' && Object.prototype.hasOwnProperty.call(IMAGE_AD_PRESET_MAP, presetId);
}

/**
 * Look up preset by ID.
 */
export function getImagePreset(presetId: string): ImageAdPreset | null {
  return isApprovedImagePreset(presetId) ? IMAGE_AD_PRESET_MAP[presetId] : null;
}

/**
 * Finds preset by exact dimensions.
 */
export function findPresetByExactDimensions(width: number, height: number): ImageAdPreset | null {
  return (
    APPROVED_IMAGE_AD_PRESETS.find((p) => p.width === width && p.height === height) ?? null
  );
}

/**
 * Checks if dimensions match an approved preset exactly.
 */
export function matchesApprovedPresetDimensions(width: number, height: number): boolean {
  return findPresetByExactDimensions(width, height) !== null;
}

/**
 * Validates slot allowed presets array or policy.
 * - empty/null/undefined -> 'auto_any_approved' (all 9 fitting sizes eligible)
 * - 1 valid preset -> 'fixed'
 * - 2+ valid presets -> 'allowed_set'
 * Rejects unknown preset IDs.
 */
export function normalizeSlotPresetPolicy(presets?: string[] | null): {
  policy: 'auto_any_approved' | 'fixed' | 'allowed_set';
  allowedPresetIds: string[];
} {
  if (!presets || !Array.isArray(presets) || presets.length === 0) {
    return {
      policy: 'auto_any_approved',
      allowedPresetIds: [...APPROVED_IMAGE_PRESET_IDS],
    };
  }

  const unique = Array.from(new Set(presets.map((s) => String(s).trim()))).filter(Boolean);
  if (unique.length === 0) {
    return {
      policy: 'auto_any_approved',
      allowedPresetIds: [...APPROVED_IMAGE_PRESET_IDS],
    };
  }

  // Reject any unapproved preset ID
  for (const id of unique) {
    if (!isApprovedImagePreset(id)) {
      throw new Error(`Invalid image ad preset ID: '${id}'. Must be one of: ${APPROVED_IMAGE_PRESET_IDS.join(', ')}`);
    }
  }

  return {
    policy: unique.length === 1 ? 'fixed' : 'allowed_set',
    allowedPresetIds: unique,
  };
}

/**
 * Allowed source downscaling rules.
 * 600x600 is valid high-res source for square (250x250) and large_square (300x300).
 * Sources of the same aspect ratio can be scaled DOWN to approved presets, never upscaled.
 */
export function canSourceFulfillPreset(
  sourceWidth: number,
  sourceHeight: number,
  targetPresetId: string
): { eligible: boolean; reason?: string } {
  const target = getImagePreset(targetPresetId);
  if (!target) {
    return { eligible: false, reason: `Unknown preset ID: ${targetPresetId}` };
  }

  // Dimension check: source cannot be smaller than target (no upscaling)
  if (sourceWidth < target.width || sourceHeight < target.height) {
    return {
      eligible: false,
      reason: `Source dimensions (${sourceWidth}x${sourceHeight}) are smaller than target preset ${target.id} (${target.width}x${target.height}). Upscaling is forbidden.`,
    };
  }

  // Check aspect ratio tolerance (<= 0.01 deviation)
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = target.width / target.height;
  if (Math.abs(sourceRatio - targetRatio) > 0.01) {
    return {
      eligible: false,
      reason: `Source aspect ratio (${sourceRatio.toFixed(3)}) does not match preset ratio (${targetRatio.toFixed(3)}). Explicit crop is required.`,
    };
  }

  return { eligible: true };
}


export const GENERAL_SLOT_IMAGE_CAP = 250_000;

type SlotRendition = { url: string; width: number; height: number; bytes: number };

export function selectGeneralSlotImage(
  renditions: readonly SlotRendition[],
  slot: { allowedPresetIds?: string | null; width?: number | null; height?: number | null },
  selectedUrl?: string,
) {
  if (!Array.isArray(renditions)) return null;
  let ids = APPROVED_IMAGE_PRESET_IDS;
  if (slot.allowedPresetIds != null) {
    try {
      const stored: unknown = JSON.parse(slot.allowedPresetIds);
      if (!Array.isArray(stored) || !stored.length || !stored.every(isApprovedImagePreset)) return null;
      ids = stored;
    } catch {
      return null;
    }
  }
  const choices = renditions.filter(image => image != null &&
    typeof image.url === 'string' && image.url.length > 0 &&
    (selectedUrl === undefined || image.url === selectedUrl) &&
    Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) &&
    Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= GENERAL_SLOT_IMAGE_CAP,
  ).sort((a, b) => a.bytes - b.bytes);
  for (const image of choices) {
    const preset = ids.map(id => IMAGE_AD_PRESET_MAP[id])
      .filter(item => (slot.width == null || item.width <= slot.width) &&
        (slot.height == null || item.height <= slot.height) &&
        canSourceFulfillPreset(image.width, image.height, item.id).eligible)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (preset) return { ...image, width: preset.width, height: preset.height, presetId: preset.id };
  }
  return null;
}
