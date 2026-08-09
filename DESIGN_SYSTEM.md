# Crimfig Design System & Brand Guidelines
> **Version:** 1.0 · **Created:** 2026-08-08 · **Maintained by:** Design & Frontend Teams
>
> This is the **single source of truth** for all visual design decisions across the Crimfig Ecosystem.
> All frontend developers (web and mobile) must reference this document before writing any UI code.
> All design tokens defined here should be mirrored in the shared design token package at `frontend/shared/design-tokens/`.

---

## 1. Brand Identity

**Brand Name:** CrimFig
**Brand Voice:** Modern · Confident · Clean · African
**Platform Target:** Nigeria-first, Africa-wide. Design must be culturally neutral and accessible across all African regions and devices (including low-end Android phones).

---

## 2. Brand Typeface

### Primary Font: Poppins

Poppins is the **only approved typeface** for all CrimFig digital products. It is a geometric modern sans-serif available from Google Fonts and must be loaded via `@fontsource/poppins` in production (not a CDN link) to guarantee offline availability and performance.

| Use | Font | Weight | Weight Name |
|---|---|---|---|
| Primary wordmark / Logo text | Poppins | 500–600 | Medium / SemiBold |
| Digital headings (H1–H3) | Poppins | 600–700 | SemiBold / Bold |
| Subheadings (H4–H6) | Poppins | 500–600 | Medium / SemiBold |
| Body text / UI copy | Poppins | 400 | Regular |
| Captions / Labels | Poppins | 400–500 | Regular / Medium |
| Buttons / CTAs | Poppins | 500–600 | Medium / SemiBold |
| **Fallback (system)** | Arial / Helvetica | Regular–Bold | — |

### Font Stack (CSS)
```css
font-family: 'Poppins', Arial, Helvetica, sans-serif;
```

### Type Scale (Web & Mobile)

| Token | Size | Weight | Use |
|---|---|---|---|
| `--text-display` | 48px / 3rem | 700 | Hero headlines |
| `--text-h1` | 36px / 2.25rem | 700 | Page titles |
| `--text-h2` | 28px / 1.75rem | 600 | Section headings |
| `--text-h3` | 22px / 1.375rem | 600 | Card headings |
| `--text-h4` | 18px / 1.125rem | 500 | Sub-section headings |
| `--text-body-lg` | 16px / 1rem | 400 | Primary body text |
| `--text-body` | 14px / 0.875rem | 400 | Standard UI text |
| `--text-sm` | 12px / 0.75rem | 400 | Captions, labels, helpers |
| `--text-xs` | 10px / 0.625rem | 500 | Badges, tags, overlines |

---

## 3. Primary Colour Palette

### Brand Colours

| Token Name | HEX | RGB | Recommended Use |
|---|---|---|---|
| `--color-crimson` | `#D4143A` | 212, 20, 58 | **Primary brand colour** — CTAs, primary buttons, active states, brand icon |
| `--color-crimson-dark` | `#A80F32` | 168, 15, 50 | Hover states, pressed states, dark crimson variation |
| `--color-crimson-light` | `#E31B45` | 227, 27, 69 | Gradient highlight, emphasis, badges |
| `--color-fig-dark` | `#171B2A` | 23, 27, 42 | Headings, body text on light backgrounds, dark UI surfaces |
| `--color-white` | `#FFFFFF` | 255, 255, 255 | Primary background, negative space, text on dark surfaces |
| `--color-soft-gray` | `#F5F6F8` | 245, 246, 248 | Secondary backgrounds, card surfaces, page fills |

### Extended Neutral Palette

| Token Name | HEX | Use |
|---|---|---|
| `--color-gray-900` | `#111318` | Darkest text / near-black surfaces |
| `--color-gray-800` | `#1E2130` | Dark sidebar / navigation backgrounds |
| `--color-gray-700` | `#2D3148` | Secondary dark surfaces |
| `--color-gray-600` | `#4A5068` | Muted text, disabled labels |
| `--color-gray-500` | `#6B7280` | Placeholder text, icons on light bg |
| `--color-gray-400` | `#9CA3AF` | Dividers, borders |
| `--color-gray-300` | `#D1D5DB` | Input borders, subtle dividers |
| `--color-gray-200` | `#E5E7EB` | Card borders, light dividers |
| `--color-gray-100` | `#F3F4F6` | Hover states on white surfaces |
| `--color-gray-50` | `#F9FAFB` | Alternate background fill |

### Semantic / Status Colours

| Token Name | HEX | Use |
|---|---|---|
| `--color-success` | `#16A34A` | Success states, confirmations |
| `--color-success-bg` | `#DCFCE7` | Success banners, toasts |
| `--color-warning` | `#D97706` | Warnings, pending states |
| `--color-warning-bg` | `#FEF3C7` | Warning banners |
| `--color-error` | `#DC2626` | Error states, destructive actions |
| `--color-error-bg` | `#FEE2E2` | Error banners, toasts |
| `--color-info` | `#2563EB` | Informational states |
| `--color-info-bg` | `#DBEAFE` | Info banners |

> **Note:** Do not use brand crimson for error states. Crimson is exclusively a brand/CTA colour. Error red is a separate, distinct `--color-error` token.

---

## 4. Gradients

### Primary Brand Gradient
```css
/* Crimson brand gradient — used on hero sections, buttons, CTAs, cards */
background: linear-gradient(135deg, #E31B45 0%, #A80F32 100%);

/* Crimson gradient (horizontal) */
background: linear-gradient(90deg, #E31B45 0%, #A80F32 100%);
```
> Use the brighter crimson (`#E31B45`) toward the light source / highlight edge, and the deeper crimson (`#A80F32`) toward the shadow edge. Gradients should be **subtle** — the brand must still read as a flat crimson mark at a glance.

### Dark Surface Gradient
```css
/* Dark card or hero background gradient */
background: linear-gradient(135deg, #1E2130 0%, #171B2A 100%);
```

### Overlay Gradient (for image overlays)
```css
/* Used over photographic backgrounds to ensure text legibility */
background: linear-gradient(180deg, transparent 0%, rgba(23, 27, 42, 0.85) 100%);
```

---

## 5. Icon Standards

### ⚠️ Critical Rule: No Multi-Coloured Icons in the Same Section

> **This rule is non-negotiable across all Crimfig apps.**
>
> Within any given UI section, card group, navigation bar, sidebar, or tab bar, **all icons must use a single, consistent colour**. Mixing icon colours within the same section is strictly prohibited.

### Icon Colour Rules by Context

| Context | Icon Colour | Token |
|---|---|---|
| Primary navigation (active state) | CrimFig Crimson | `--color-crimson` |
| Primary navigation (inactive state) | Muted Gray | `--color-gray-500` |
| Dark sidebar / drawer | White or Soft Gray | `--color-white` / `--color-gray-400` |
| Cards on white background | Fig Dark | `--color-fig-dark` |
| Danger / destructive actions | Error red | `--color-error` |
| Success confirmations | Success green | `--color-success` |
| Informational tooltips | Info blue | `--color-info` |
| Buttons (primary / crimson bg) | White | `--color-white` |
| Icon-only buttons on light bg | Fig Dark | `--color-fig-dark` |

### Icon Style Guidelines
- Use a **single consistent icon library** per app. Recommended: `lucide-react` (web) and `@expo/vector-icons` (mobile) with Lucide icons.
- Icons within a section must all be the **same size** (do not mix 16px and 24px icons in the same list/row).
- Standard sizes: `16px` (inline/label icons), `20px` (button icons), `24px` (navigation/card icons), `32px` (feature icons), `48px` (hero icons).
- Prefer **outline icons** for navigation and UI; **filled icons** only for active/selected states.
- Never apply `stroke` and `fill` colours simultaneously on the same icon — pick one treatment and be consistent within the section.

---

## 6. Logo Usage

### Do ✅
- Use the crimson icon on **white** (`#FFFFFF`) or **soft gray** (`#F5F6F8`) backgrounds.
- Use the **Fig Dark** (`#171B2A`) colour for the "Fig" portion of the wordmark and all supporting text.
- Maintain **generous clear space** around the icon and wordmark (minimum clear space = height of the "C" symbol on all sides).
- For **small app icons or favicons** (≤ 32px): use the standalone crimson "C"/fig symbol without the wordmark.
- On dark backgrounds: use the **white wordmark** with the crimson icon mark.

### Don't ❌
- Do not add shadows, outlines, bevels, or drop shadows to the logo.
- Do not recolour the icon to any colour other than crimson or white.
- Do not stretch, skew, rotate, or distort the logo.
- Do not place the logo on busy photographic backgrounds without an overlay.
- Do not use additional colours in the logo unless creating a specific approved campaign treatment.
- Do not recreate the wordmark in any font other than Poppins.

---

## 7. Spacing & Layout System

### Base Unit: 4px
All spacing values are multiples of `4px`.

| Token | Value | Use |
|---|---|---|
| `--space-1` | 4px | Micro spacing, icon gaps |
| `--space-2` | 8px | Tight padding, small gaps |
| `--space-3` | 12px | Input padding (vertical) |
| `--space-4` | 16px | Standard card padding, list item padding |
| `--space-5` | 20px | Section element spacing |
| `--space-6` | 24px | Card padding, form field spacing |
| `--space-8` | 32px | Section inner padding |
| `--space-10` | 40px | Large section spacing |
| `--space-12` | 48px | Page section gaps |
| `--space-16` | 64px | Major section separators |
| `--space-20` | 80px | Hero padding |
| `--space-24` | 96px | Large hero / landing sections |

---

## 8. Border Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Tags, badges, inputs |
| `--radius-md` | 8px | Buttons, cards, dropdowns |
| `--radius-lg` | 12px | Modals, large cards |
| `--radius-xl` | 16px | Feature cards, panels |
| `--radius-2xl` | 24px | Hero cards, bottom sheets |
| `--radius-full` | 9999px | Pills, avatar circles, toggle switches |

---

## 9. Shadows & Elevation

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(23,27,42,0.06)` | Subtle card lift |
| `--shadow-md` | `0 4px 12px rgba(23,27,42,0.10)` | Cards, dropdowns |
| `--shadow-lg` | `0 8px 24px rgba(23,27,42,0.14)` | Modals, popovers |
| `--shadow-xl` | `0 16px 48px rgba(23,27,42,0.18)` | Floating panels, drawers |
| `--shadow-crimson` | `0 4px 20px rgba(212,20,58,0.30)` | Crimson CTA buttons (glow effect) |

---

## 10. Dark Mode Considerations

Crimfig apps should support a **dark mode** from the start. The base dark surface is `--color-fig-dark` (`#171B2A`) with layered dark gray surfaces above it.

| Role | Light Mode | Dark Mode |
|---|---|---|
| Page background | `#FFFFFF` | `#171B2A` |
| Surface (cards) | `#F5F6F8` | `#1E2130` |
| Surface elevated | `#FFFFFF` | `#2D3148` |
| Primary text | `#171B2A` | `#F5F6F8` |
| Secondary text | `#4A5068` | `#9CA3AF` |
| Border | `#E5E7EB` | `#2D3148` |
| Brand accent | `#D4143A` | `#E31B45` (slightly lighter for contrast) |

---

## 11. CSS Custom Properties Template

Copy this into the root `:root` block of each app's `globals.css`:

```css
:root {
  /* Brand Colours */
  --color-crimson: #D4143A;
  --color-crimson-dark: #A80F32;
  --color-crimson-light: #E31B45;
  --color-fig-dark: #171B2A;
  --color-white: #FFFFFF;
  --color-soft-gray: #F5F6F8;

  /* Neutrals */
  --color-gray-900: #111318;
  --color-gray-800: #1E2130;
  --color-gray-700: #2D3148;
  --color-gray-600: #4A5068;
  --color-gray-500: #6B7280;
  --color-gray-400: #9CA3AF;
  --color-gray-300: #D1D5DB;
  --color-gray-200: #E5E7EB;
  --color-gray-100: #F3F4F6;
  --color-gray-50: #F9FAFB;

  /* Semantic */
  --color-success: #16A34A;
  --color-success-bg: #DCFCE7;
  --color-warning: #D97706;
  --color-warning-bg: #FEF3C7;
  --color-error: #DC2626;
  --color-error-bg: #FEE2E2;
  --color-info: #2563EB;
  --color-info-bg: #DBEAFE;

  /* Typography */
  --font-primary: 'Poppins', Arial, Helvetica, sans-serif;
  --text-display: 3rem;
  --text-h1: 2.25rem;
  --text-h2: 1.75rem;
  --text-h3: 1.375rem;
  --text-h4: 1.125rem;
  --text-body-lg: 1rem;
  --text-body: 0.875rem;
  --text-sm: 0.75rem;
  --text-xs: 0.625rem;

  /* Spacing */
  --space-1: 4px;   --space-2: 8px;   --space-3: 12px;
  --space-4: 16px;  --space-5: 20px;  --space-6: 24px;
  --space-8: 32px;  --space-10: 40px; --space-12: 48px;
  --space-16: 64px; --space-20: 80px; --space-24: 96px;

  /* Border Radius */
  --radius-sm: 4px;   --radius-md: 8px;    --radius-lg: 12px;
  --radius-xl: 16px;  --radius-2xl: 24px;  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(23,27,42,0.06);
  --shadow-md: 0 4px 12px rgba(23,27,42,0.10);
  --shadow-lg: 0 8px 24px rgba(23,27,42,0.14);
  --shadow-xl: 0 16px 48px rgba(23,27,42,0.18);
  --shadow-crimson: 0 4px 20px rgba(212,20,58,0.30);

  /* Gradients */
  --gradient-crimson: linear-gradient(135deg, #E31B45 0%, #A80F32 100%);
  --gradient-dark: linear-gradient(135deg, #1E2130 0%, #171B2A 100%);
}

[data-theme="dark"] {
  --color-white: #171B2A;
  --color-soft-gray: #1E2130;
  --color-fig-dark: #F5F6F8;
  --color-gray-200: #2D3148;
  --color-gray-300: #2D3148;
  --color-gray-500: #9CA3AF;
  --color-crimson: #E31B45;
}
```

---

## 12. Per-App Theme Identity

While all apps share the same base Crimfig brand system, each sub-app may have a subtle **accent identity** layered on top of the core crimson brand — useful for helping users visually distinguish which Crimfig product they are in.

| App | Subdomain | Accent Overlay Idea | Primary Identity |
|---|---|---|---|
| Auth (SSO) | auth.crimfig.com | Pure Crimfig crimson — no overlay | Brand flagship |
| Ads | ads.crimfig.com | Deep navy + crimson | Professional / B2B |
| Chat | chat.crimfig.com | Crimson + warm off-white | Friendly / Conversational |
| Reels | reels.crimfig.com | Crimson + dark cinematic black | Entertainment |
| Stream | stream.crimfig.com | Crimson + purple-tinted dark | Live / Broadcast |
| Tetris | tetrisgame.crimfig.com | Crimson + neon green accents | Gaming / Fun |

> Accent overlays are **additive only** — they never replace or conflict with the core brand colours. The logo, primary CTAs, and wordmark always remain in the Crimfig Crimson family.

---

## 13. Design Token Package (Shared)

All the CSS tokens above are also exported as a TypeScript constants file from `frontend/shared/design-tokens/src/tokens.ts` so they can be used in React Native (mobile) and any JS-based animation or theming logic:

```typescript
// frontend/shared/design-tokens/src/tokens.ts
export const COLORS = {
  CRIMSON: '#D4143A',
  CRIMSON_DARK: '#A80F32',
  CRIMSON_LIGHT: '#E31B45',
  FIG_DARK: '#171B2A',
  WHITE: '#FFFFFF',
  SOFT_GRAY: '#F5F6F8',
  // ... all tokens
} as const;

export const FONT_FAMILY = {
  PRIMARY: 'Poppins',
  FALLBACK: 'Arial, Helvetica, sans-serif',
} as const;

export const SPACING = {
  S1: 4, S2: 8, S3: 12, S4: 16,
  S5: 20, S6: 24, S8: 32, S10: 40,
  S12: 48, S16: 64, S20: 80, S24: 96,
} as const;
```
