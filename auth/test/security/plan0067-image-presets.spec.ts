import {
  APPROVED_IMAGE_AD_PRESETS,
  APPROVED_IMAGE_PRESET_IDS,
  IMAGE_AD_PRESET_MAP,
  isApprovedImagePreset,
  getImagePreset,
  findPresetByExactDimensions,
  matchesApprovedPresetDimensions,
  normalizeSlotPresetPolicy,
  canSourceFulfillPreset,
  CURRENT_IMAGE_PRESETS_POLICY_VERSION,
} from '../../../api/ads-api/src/modules/uploads/image-ad-presets';

describe('PLAN-0067 Canonical Image Ad Presets and Validation', () => {
  describe('Failure and Rejection First (Negative Cases)', () => {
    it('rejects unknown or unapproved preset IDs', () => {
      expect(isApprovedImagePreset('half_banner')).toBe(false);
      expect(isApprovedImagePreset('skyscraper_160x600')).toBe(false);
      expect(isApprovedImagePreset('custom_600x600')).toBe(false);
      expect(isApprovedImagePreset('')).toBe(false);
      expect(isApprovedImagePreset(null as any)).toBe(false);
    });

    it('rejects slot preset list with any invalid preset ID', () => {
      expect(() => {
        normalizeSlotPresetPolicy(['medium_rectangle', 'invalid_slot_id']);
      }).toThrow(/Invalid image ad preset ID: 'invalid_slot_id'/);

      expect(() => {
        normalizeSlotPresetPolicy(['sidebar_160_600']);
      }).toThrow(/Invalid image ad preset ID: 'sidebar_160_600'/);
    });

    it('rejects upscaling when source dimensions are smaller than target preset', () => {
      // Trying to fulfill 300x250 with 250x208
      const res = canSourceFulfillPreset(250, 208, 'medium_rectangle');
      expect(res.eligible).toBe(false);
      expect(res.reason).toMatch(/Upscaling is forbidden/);
    });

    it('rejects source fulfillment when aspect ratio diverges without crop', () => {
      // 300x300 (1:1) cannot fulfill medium_rectangle (300x250, 1.2:1) directly without crop
      const res = canSourceFulfillPreset(300, 300, 'medium_rectangle');
      expect(res.eligible).toBe(false);
      expect(res.reason).toMatch(/Explicit crop is required/);
    });

    it('rejects source fulfillment for non-existent preset', () => {
      const res = canSourceFulfillPreset(600, 600, 'unknown_preset');
      expect(res.eligible).toBe(false);
      expect(res.reason).toMatch(/Unknown preset ID/);
    });

    it('does not recognize 600x600 as a display preset itself', () => {
      expect(isApprovedImagePreset('600x600')).toBe(false);
      expect(findPresetByExactDimensions(600, 600)).toBeNull();
      expect(matchesApprovedPresetDimensions(600, 600)).toBe(false);
    });
  });

  describe('Positive Validation and Canonical Presets', () => {
    it('contains exactly nine approved image presets', () => {
      expect(APPROVED_IMAGE_AD_PRESETS.length).toBe(9);
      expect(APPROVED_IMAGE_PRESET_IDS.length).toBe(9);
      expect(Object.keys(IMAGE_AD_PRESET_MAP).length).toBe(9);
    });

    it('verifies exact dimensions and reduced integer ratios for all 9 presets', () => {
      const expectedPresets = [
        { id: 'medium_rectangle', w: 300, h: 250, num: 6, den: 5 },
        { id: 'large_rectangle', w: 336, h: 280, num: 6, den: 5 },
        { id: 'leaderboard', w: 728, h: 90, num: 364, den: 45 },
        { id: 'mobile_banner', w: 320, h: 50, num: 32, den: 5 },
        { id: 'large_mobile_banner', w: 320, h: 100, num: 16, den: 5 },
        { id: 'half_page', w: 300, h: 600, num: 1, den: 2 },
        { id: 'billboard', w: 970, h: 250, num: 97, den: 25 },
        { id: 'square', w: 250, h: 250, num: 1, den: 1 },
        { id: 'large_square', w: 300, h: 300, num: 1, den: 1 },
      ];

      for (const exp of expectedPresets) {
        const p = getImagePreset(exp.id);
        expect(p).not.toBeNull();
        expect(p!.width).toBe(exp.w);
        expect(p!.height).toBe(exp.h);
        expect(p!.ratioNumerator).toBe(exp.num);
        expect(p!.ratioDenominator).toBe(exp.den);
        // Ensure mathematically reduced: gcd(num, den) === 1
        const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
        expect(gcd(p!.ratioNumerator, p!.ratioDenominator)).toBe(1);
      }
    });

    it('finds preset by exact dimensions', () => {
      expect(findPresetByExactDimensions(300, 250)?.id).toBe('medium_rectangle');
      expect(findPresetByExactDimensions(728, 90)?.id).toBe('leaderboard');
      expect(findPresetByExactDimensions(250, 250)?.id).toBe('square');
      expect(findPresetByExactDimensions(300, 300)?.id).toBe('large_square');
    });

    it('normalizes empty, null, or undefined slot preset selection to auto_any_approved', () => {
      const fromNull = normalizeSlotPresetPolicy(null);
      expect(fromNull.policy).toBe('auto_any_approved');
      expect(fromNull.allowedPresetIds).toEqual(APPROVED_IMAGE_PRESET_IDS);

      const fromEmpty = normalizeSlotPresetPolicy([]);
      expect(fromEmpty.policy).toBe('auto_any_approved');
      expect(fromEmpty.allowedPresetIds).toEqual(APPROVED_IMAGE_PRESET_IDS);

      const fromUndefined = normalizeSlotPresetPolicy(undefined);
      expect(fromUndefined.policy).toBe('auto_any_approved');
      expect(fromUndefined.allowedPresetIds).toEqual(APPROVED_IMAGE_PRESET_IDS);
    });

    it('normalizes single preset selection to fixed policy', () => {
      const res = normalizeSlotPresetPolicy(['leaderboard']);
      expect(res.policy).toBe('fixed');
      expect(res.allowedPresetIds).toEqual(['leaderboard']);
    });

    it('normalizes multiple presets selection to allowed_set policy', () => {
      const res = normalizeSlotPresetPolicy(['medium_rectangle', 'large_rectangle']);
      expect(res.policy).toBe('allowed_set');
      expect(res.allowedPresetIds).toEqual(['medium_rectangle', 'large_rectangle']);
    });

    it('allows 600x600 high-res source to fulfill square and large_square through downscaling', () => {
      const toSquare = canSourceFulfillPreset(600, 600, 'square');
      expect(toSquare.eligible).toBe(true);

      const toLargeSquare = canSourceFulfillPreset(600, 600, 'large_square');
      expect(toLargeSquare.eligible).toBe(true);
    });

    it('allows larger same-ratio source to downscale to medium_rectangle', () => {
      // 600x500 has ratio 1.2 (same as 300x250)
      const res = canSourceFulfillPreset(600, 500, 'medium_rectangle');
      expect(res.eligible).toBe(true);
    });

    it('exports policy version 1', () => {
      expect(CURRENT_IMAGE_PRESETS_POLICY_VERSION).toBe(1);
    });
  });
});

