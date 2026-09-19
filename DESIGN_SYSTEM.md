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
All spacing values are multiples of `4px` adhering to a strict geometric scale.

| Token | Value (px / rem) | Use Case |
|---|---|---|
| `--space-0` | 0px | Reset margins/padding |
| `--space-1` | 4px / 0.25rem | Micro spacing, icon-to-text gap, badge padding (vertical) |
| `--space-2` | 8px / 0.5rem | Tight padding, inline chip gaps, compact list item gaps |
| `--space-3` | 12px / 0.75rem | Input vertical padding, table cell vertical padding, compact buttons |
| `--space-4` | 16px / 1rem | **Default Base Spacing** — standard card padding, button horizontal padding, list item gaps |
| `--space-5` | 20px / 1.25rem | Medium component padding, stack item gaps |
| `--space-6` | 24px / 1.5rem | Card body padding, modal inner padding, form field vertical spacing |
| `--space-8` | 32px / 2rem | Section inner padding, card grid gaps, dashboard widget gaps |
| `--space-10` | 40px / 2.5rem | Large section spacing, container gutters on desktop |
| `--space-12` | 48px / 3rem | Page section gaps, feature block separation |
| `--space-16` | 64px / 4rem | Major section separators, landing page section blocks |
| `--space-20` | 80px / 5rem | Hero block padding (vertical) |
| `--space-24` | 96px / 6rem | Extended landing page hero / splash section padding |

---

### Padding Requirements (Component Level)

Padding controls the internal breathing room within interactive elements and containers.

#### 1. Buttons & Interactive Controls
- **Compact / Small Button:** `--space-1` (4px) or `--space-2` (8px) vertical, `--space-3` (12px) horizontal.
- **Standard Button (Default):** `--space-3` (12px) vertical, `--space-4` (16px) or `--space-5` (20px) horizontal. Minimum tap target height: **44px** (mobile accessibility).
- **Large / CTA Button:** `--space-4` (16px) vertical, `--space-6` (24px) horizontal. Minimum height: **48px–52px**.
- **Icon-Only Button:** Square aspect ratio. `--space-2` (8px) or `--space-3` (12px) uniform padding.

#### 2. Form Inputs & Controls
- **Text Inputs, Selects, Textareas:**
  - Vertical padding: `--space-3` (12px).
  - Horizontal padding: `--space-4` (16px).
  - Prefix / Suffix icon inset: `--space-3` (12px) from edge.
- **Checkboxes & Radios:** Hit target container padding of `--space-2` (8px) around the control.

#### 3. Cards & Content Surfaces
- **Compact Card (e.g. status widget, small metric):** `--space-3` (12px) or `--space-4` (16px) uniform padding.
- **Standard Card (Default):** `--space-5` (20px) on mobile, `--space-6` (24px) on desktop.
- **Feature / Hero Card:** `--space-6` (24px) on mobile, `--space-8` (32px) on desktop.
- **Card Header / Footer Separation:** `--space-4` (16px) or `--space-5` (20px) vertical padding.

#### 4. Modals, Dialogs & Drawers
- **Modal Header:** `--space-5` (20px) horizontal, `--space-4` (16px) vertical.
- **Modal Body:** `--space-6` (24px) uniform padding.
- **Modal Footer (Action Bar):** `--space-4` (16px) vertical, `--space-6` (24px) horizontal.
- **Bottom Sheet / Mobile Drawer:** Top padding `--space-4` (16px) with drag pill handle; side padding `--space-5` (20px).

#### 5. Data Tables
- **Header Cells (`<th>`):** `--space-3` (12px) vertical, `--space-4` (16px) horizontal.
- **Body Cells (`<td>`):** `--space-3` (12px) vertical (dense) or `--space-4` (16px) vertical (comfortable), `--space-4` (16px) horizontal.

---

### Margin Requirements (External Spacing & Flow)

Margins define separation between distinct siblings and structural page elements.

#### 1. Typography Vertical Rhythms
- **Headings (H1–H3):** Margin bottom `--space-2` (8px) or `--space-3` (12px). Top margin when preceded by content: `--space-6` (24px).
- **Subheadings (H4–H6):** Margin bottom `--space-2` (8px). Top margin when preceded by content: `--space-4` (16px).
- **Paragraphs / Body Copy:** Margin bottom `--space-4` (16px). Last child must have margin bottom `0`.
- **Form Field Labels:** Margin bottom `--space-2` (8px) above the input.
- **Form Field Error / Helper Text:** Margin top `--space-1` (4px) or `--space-2` (8px) below input.

#### 2. Form Layout Margins
- **Between adjacent form fields:** Vertical margin `--space-4` (16px) or `--space-5` (20px).
- **Between form field groups / fieldsets:** Vertical margin `--space-6` (24px) or `--space-8` (32px).
- **Form Submit Button:** Top margin `--space-6` (24px) above the action row.

#### 3. Section Margins
- **Page Header to Content:** Bottom margin `--space-6` (24px) on mobile, `--space-8` (32px) on desktop.
- **Between major content sections:** Bottom margin `--space-10` (40px) to `--space-16` (64px).

---

### Gap Requirements (Flexbox & CSS Grid)

Use native CSS `gap` for layout collections instead of margin hacks.

#### 1. Inline & Row Layouts (Flexbox Row)
- **Inline Badge / Tag Groups:** `gap: var(--space-2)` (8px).
- **Icon + Text:** `gap: var(--space-2)` (8px). For compact badges: `gap: var(--space-1)` (4px).
- **Button Groups (e.g., Cancel + Confirm):** `gap: var(--space-3)` (12px) on mobile, `gap: var(--space-4)` (16px) on desktop.
- **Navigation Bar Items:** `gap: var(--space-6)` (24px) or `gap: var(--space-8)` (32px).
- **Breadcrumb Items:** `gap: var(--space-2)` (8px).

#### 2. Stack Layouts (Flexbox Column)
- **Tight Stack (e.g. title + subtitle):** `gap: var(--space-1)` (4px).
- **Standard Stack (e.g. list items, notifications):** `gap: var(--space-3)` (12px) or `gap: var(--space-4)` (16px).
- **Form Vertical Stack:** `gap: var(--space-4)` (16px) or `gap: var(--space-5)` (20px).
- **Settings / Preference Group Rows:** `gap: var(--space-4)` (16px).

#### 3. Grid Layouts (CSS Grid)
- **Card Grids (Dashboard / Marketplace / Ads):**
  - Mobile (1 column): `gap: var(--space-4)` (16px).
  - Tablet (2 columns): `gap: var(--space-5)` (20px).
  - Desktop (3–4 columns): `gap: var(--space-6)` (24px) or `gap: var(--space-8)` (32px).
- **Gallery / Media Thumbnails:** `gap: var(--space-2)` (8px) or `gap: var(--space-3)` (12px).
- **Stats / Metric KPI Grid:** `gap: var(--space-4)` (16px) or `gap: var(--space-6)` (24px).

---

### Layout Containers & Viewport Gutters

Every page must maintain consistent edge gutters to prevent content from touching viewport boundaries on mobile and wide displays.

| Screen Size | Breakpoint | Container Max Width | Page Side Padding (Gutters) |
|---|---|---|---|
| Mobile (Compact) | `< 640px` | `100%` | `--space-4` (16px) |
| Tablet (Medium) | `640px – 1024px` | `100%` | `--space-6` (24px) |
| Desktop (Large) | `1024px – 1280px` | `1200px` | `--space-8` (32px) |
| Wide / Ultra-wide | `> 1280px` | `1440px` | `--space-10` (40px) or centered |

#### Dashboard Layout Structure
- **Sidebar Width (Desktop):** `260px` fixed.
- **Sidebar Padding:** `--space-4` (16px) horizontal, `--space-6` (24px) vertical.
- **Top Header Bar Height:** `64px` fixed, with `--space-6` (24px) horizontal padding.
- **Main Content Area:** Padding `--space-6` (24px) on tablet/mobile, `--space-8` (32px) on desktop.

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

## 10. Theme & Mode Strategy: Light Theme by Default

### ⚠️ Core Principle: White Background by Default
> **CrimFig prioritizes a crisp, high-contrast white and soft-gray background across all web and mobile applications.**
>
> - **Default State:** All applications **must default to Light Theme** (`--color-white: #FFFFFF` and `--color-soft-gray: #F5F6F8`) on initial visit, regardless of operating system preference, unless the user has explicitly toggled and saved a preference.
> - **Visual Hierarchy:** Light surfaces convey clarity, professionalism, and high readability in African ambient daylight conditions.
> - **Dark Mode as an Opt-In Alternative:** Dark mode remains fully supported for night viewing and battery efficiency, but is never the default experience.

---

### Theme Surface & Semantic Roles

| Role | Light Theme (**Default**) | Dark Theme (Opt-In) | Description |
|---|---|---|---|
| **Page Canvas / Body** | `#FFFFFF` (`--color-white`) | `#171B2A` (`--color-fig-dark`) | Main application backdrop |
| **Card / Panel Surface** | `#F5F6F8` (`--color-soft-gray`) | `#1E2130` (`--color-gray-800`) | Standard card containers |
| **Elevated Surface / Popovers** | `#FFFFFF` (`--color-white`) | `#2D3148` (`--color-gray-700`) | Modals, dropdowns, sticky headers |
| **Primary Typography** | `#171B2A` (`--color-fig-dark`) | `#F5F6F8` (`--color-soft-gray`) | High-contrast readable text |
| **Muted / Secondary Typography** | `#4A5068` (`--color-gray-600`) | `#9CA3AF` (`--color-gray-400`) | Subtitles, labels, timestamps |
| **Dividers & Borders** | `#E5E7EB` (`--color-gray-200`) | `#2D3148` (`--color-gray-700`) | Subtle boundaries between items |
| **Brand Accent / CTAs** | `#D4143A` (`--color-crimson`) | `#E31B45` (`--color-crimson-light`) | Action buttons, active badges |

---

### Footer Theme Switcher Requirement

Every page with a footer **must provide an accessible, prominent Theme Switcher** allowing users to toggle between Light and Dark themes.

#### 1. Placement & Layout
- **Location:** Integrated directly into the page `<footer>` (typically in the bottom utility row alongside copyright, language selector, or status badges).
- **Positioning:** Right-aligned on desktop, centered or stacked on mobile screens.
- **Components Available:**
  - **Pill Segmented Control:** Two segments labeled `Light` (with a Sun icon `☀️` / Lucide `Sun`) and `Dark` (with a Moon icon `🌙` / Lucide `Moon`).
  - **Icon Toggle Button:** Single button displaying the alternate mode icon with accessible `aria-label="Switch to dark theme"` or `aria-label="Switch to light theme"`.

#### 2. Functional Behavior & State Persistence
1. **Initial Load:**
   - Read saved preference from `localStorage.getItem('crimfig-theme')`.
   - If not found, **default strictly to `'light'`**.
   - Apply `data-theme="light"` (or `"dark"`) attribute on the root `<html>` or `<body>` element.
2. **User Interaction:**
   - On click, toggle between `'light'` and `'dark'`.
   - Update `data-theme` attribute immediately without page reload.
   - Persist selection to `localStorage.setItem('crimfig-theme', newTheme)` and/or cookie domain `.crimfig.com` for cross-subdomain synchronization.
3. **Smooth Transition:**
   - Apply `transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;` to root surfaces.

#### 3. Standard Footer Theme Switcher Markup Pattern (React / Next.js)

```tsx
// Shared Footer Theme Switcher Component
import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const saved = (localStorage.getItem('crimfig-theme') as 'light' | 'dark') || 'light';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const toggleTheme = (newTheme: 'light' | 'dark') => {
    setTheme(newTheme);
    localStorage.setItem('crimfig-theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  return (
    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-full border border-slate-200 dark:border-slate-700 text-xs font-medium">
      <button
        onClick={() => toggleTheme('light')}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full transition-colors ${
          theme === 'light'
            ? 'bg-white text-slate-900 shadow-sm'
            : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
        }`}
        aria-label="Light mode"
      >
        <Sun className="w-3.5 h-3.5 text-amber-500" />
        <span>Light</span>
      </button>

      <button
        onClick={() => toggleTheme('dark')}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full transition-colors ${
          theme === 'dark'
            ? 'bg-slate-900 text-white shadow-sm'
            : 'text-slate-500 hover:text-slate-900 dark:text-slate-400'
        }`}
        aria-label="Dark mode"
      >
        <Moon className="w-3.5 h-3.5 text-indigo-400" />
        <span>Dark</span>
      </button>
    </div>
  );
}
```

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
