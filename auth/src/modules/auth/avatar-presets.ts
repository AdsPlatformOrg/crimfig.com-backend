export interface AvatarPreset {
  id: string;
  label: string;
  file: string;
  alt: string;
}

export interface AvatarAttribution {
  title: string;
  artist: string;
  sourceUrl: string;
  license: 'CC0-1.0';
  licenseUrl: string;
  summary: string;
  modifications: string;
}

/** Keep this list in sync with frontend/web/auth/src/lib/avatar-presets.ts and public/avatars/chibi/manifest.json. */
export const AVATAR_PRESETS: readonly AvatarPreset[] = [
  { id: 'chibi-indigo', label: 'Indigo', file: 'chibi-indigo.webp', alt: 'Chibi ninja avatar with an indigo hood and mask' },
  { id: 'chibi-crimson', label: 'Crimson', file: 'chibi-crimson.webp', alt: 'Chibi ninja avatar with a crimson hood and mask' },
  { id: 'chibi-jade', label: 'Jade', file: 'chibi-jade.webp', alt: 'Chibi ninja avatar with a jade hood and mask' },
  { id: 'chibi-amber', label: 'Amber', file: 'chibi-amber.webp', alt: 'Chibi ninja avatar with an amber hood and mask' },
  { id: 'chibi-violet', label: 'Violet', file: 'chibi-violet.webp', alt: 'Chibi ninja avatar with a violet hood and mask' },
  { id: 'chibi-teal', label: 'Teal', file: 'chibi-teal.webp', alt: 'Chibi ninja avatar with a teal hood and mask' },
  { id: 'chibi-rose', label: 'Rose', file: 'chibi-rose.webp', alt: 'Chibi ninja avatar with a rose hood and mask' },
  { id: 'chibi-cobalt', label: 'Cobalt', file: 'chibi-cobalt.webp', alt: 'Chibi ninja avatar with a cobalt hood and mask' },
  { id: 'chibi-olive', label: 'Olive', file: 'chibi-olive.webp', alt: 'Chibi ninja avatar with an olive hood and mask' },
  { id: 'chibi-plum', label: 'Plum', file: 'chibi-plum.webp', alt: 'Chibi ninja avatar with a plum hood and mask' },
  { id: 'chibi-slate', label: 'Slate', file: 'chibi-slate.webp', alt: 'Chibi ninja avatar with a slate hood and mask' },
  { id: 'chibi-ember', label: 'Ember', file: 'chibi-ember.webp', alt: 'Chibi ninja avatar with an ember hood and mask' },
] as const;

export const DEFAULT_AVATAR_PRESET_ID = 'chibi-indigo';

export const AVATAR_ATTRIBUTION: AvatarAttribution = {
  title: '2D Chibi Ninja - 8 Actions',
  artist: 'ashuuya',
  sourceUrl: 'https://opengameart.org/content/2d-chibi-ninja-8-actions',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  summary: 'Chibi ninja avatar illustrations adapted from “2D Chibi Ninja - 8 Actions” by ashuuya (OpenGameArt), verified as CC0 1.0. Images were cropped, recolored, and composed for CrimFig.',
  modifications: 'Head and shoulders cropped from the original idle/walk sprite frames, centered on a transparent square canvas, nearest-neighbor upscaled to 512 × 512, and the blue cloth recolored per avatar. No franchise characters, logos, or third-party marks were added.',
};

export function getAvatarPreset(id: string | null | undefined): AvatarPreset | undefined {
  return AVATAR_PRESETS.find((preset) => preset.id === id);
}
