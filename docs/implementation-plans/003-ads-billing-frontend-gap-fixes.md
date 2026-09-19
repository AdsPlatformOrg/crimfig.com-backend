# 003 — ADS & BILLING Frontend Gap Fixes
> **Created:** 2026-09-19  
> **Status:** Approved (Critical scope)  
> **Apps affected:** `frontend/web/ads`, `frontend/web/billing`  
> **Maintainer:** Engineering / Frontend Team

---

## Background

Today's implementation overhauled the ADS App and Billing App landing pages to use the CrimFig Design System light theme, skeleton loading states, empty states, and a footer theme switcher. A gap audit revealed 18 issues. This plan documents and tracks the critical fixes.

---

## Decision: Auth Integration Approach

### Question
> Which auth approach should be used for passing user identity to API calls? One that an attacker cannot tamper with.

### Answer — The Google / Industry Hybrid Approach (2026 Best Practice)

CrimFig will use a **3-layer auth token architecture** — the same approach used by Google, GitHub, and all major platforms:

#### Layer 1 — Refresh Token → HttpOnly Cookie (Server-set)
- The **Auth API** (`auth.crimfig.com`) sets a **Refresh Token** in a cookie with these exact attributes:
  ```
  Set-Cookie: cf_refresh=<token>; HttpOnly; Secure; SameSite=Strict; Domain=.crimfig.com; Path=/; Max-Age=2592000
  ```
- `HttpOnly`: **JavaScript cannot read this cookie at all** — even if an attacker injects malicious scripts via XSS, they cannot steal it.
- `Secure`: Only transmitted over HTTPS — never over plain HTTP.
- `SameSite=Strict`: Cookie is never sent on cross-origin requests — blocks CSRF attacks.
- `Domain=.crimfig.com`: Shared across all subdomains (`ads.crimfig.com`, `billing.crimfig.com`, `auth.crimfig.com`).

#### Layer 2 — Access Token → In-Memory Only (JavaScript variable)
- The **short-lived JWT access token** (15-minute expiry) is stored **only in React state / memory**.
- It is **never written to `localStorage` or a readable cookie**.
- When the user refreshes the page, the token is gone — but the app silently calls `/auth/refresh` using the HttpOnly cookie to get a new one.
- An attacker with XSS access cannot steal it because it is not in any persistent storage.

#### Layer 3 — Token Rotation
- Every refresh token use issues a **new refresh token** and **invalidates the old one**.
- If an old refresh token is replayed (e.g., by a stolen cookie), the Auth API detects the double-use and immediately invalidates **all sessions** for that user.

#### Why NOT `localStorage`?
`localStorage` is readable by any JavaScript on the page — including third-party analytics, chat widgets, or any injected ad script. A single XSS vulnerability in any library exposes every token.

#### Frontend Implementation Pattern
```tsx
// In a shared auth context (frontend/shared/auth/AuthContext.tsx)
const [accessToken, setAccessToken] = useState<string | null>(null);

useEffect(() => {
  // On mount: silently refresh using the HttpOnly cookie
  fetch('https://auth.crimfig.com/api/v1/auth/refresh', {
    method: 'POST',
    credentials: 'include',  // sends the HttpOnly cookie automatically
  })
    .then(res => res.json())
    .then(json => {
      if (json.data?.accessToken) {
        setAccessToken(json.data.accessToken);
      } else {
        // No valid session — redirect to auth
        window.location.href = 'https://auth.crimfig.com/login?redirect=' + encodeURIComponent(window.location.href);
      }
    });
}, []);

// Pass accessToken in API calls as Authorization header
const headers = {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};
```

---

## Scope: Critical Fixes (Phase 1)

Only the 3 critical gaps are in scope for immediate deployment.

---

## Gap #1 — CSS Token Naming Mismatch

### Problem
`globals.css` uses semantic aliases (`--bg-page`, `--bg-surface`, `--badge-bg`) but `DESIGN_SYSTEM.md` Section 11 mandates canonical token names (`--color-white`, `--color-soft-gray`). Future shared components will be unstyled.

### Fix
Add all canonical `DESIGN_SYSTEM.md` Section 11 tokens to both `globals.css` files alongside the existing semantic aliases.

**Files:**
- `frontend/web/ads/src/app/globals.css`
- `frontend/web/billing/src/app/globals.css`

**Change:** In the `:root` block, append the canonical brand tokens from DESIGN_SYSTEM.md Section 11 after the existing semantic tokens.

---

## Gap #5 — `animate-spin` Broken (No Tailwind)

### Problem
`<Loader2 className="animate-spin" />` uses a Tailwind utility class. Tailwind is not configured — the class has no effect. Spinners are static in production.

### Fix
Replace `className="animate-spin"` with inline `style={{ animation: 'spin 0.75s linear infinite' }}`. The `@keyframes spin` already exists in `globals.css`.

**Files:**
- `frontend/web/ads/src/app/page.tsx` (lines 1270, 1340)
- `frontend/web/billing/src/app/page.tsx` (lines 959, 1055)

---

## Gap #6 — Tailwind Classes on `<body>` (Silent Failures)

### Problem
`<body className="antialiased min-h-screen">` uses Tailwind classes that don't exist. They are silently ignored but create dead code noise.

### Fix
Remove Tailwind class names from `<body>`. The equivalent styles are already applied in `globals.css` body selector.

**Files:**
- `frontend/web/ads/src/app/layout.tsx`
- `frontend/web/billing/src/app/layout.tsx`

---

## Deferred to Phase 2 (Important Gaps)
See `implementation_plan.md` in Antigravity artifacts for the full 18-gap table. Phase 2 covers:
- Gap #2: Auth integration (requires Auth API token endpoint)
- Gap #3: Poppins font variable wiring
- Gap #4: Dark mode card flash
- Gap #7: Wallet balance loading state
- Gap #8: Subscriptions API fetch
- Gap #9: Mobile apps API fetch
- Gap #10: Subscriptions empty state CTA
- Gap #11: `alert()` replacement
- Gap #12: Error states
- Gap #13: Mobile responsiveness
- Gap #14: FOUC prevention
- Gap #15: DESIGN_SYSTEM.md Section 11 update

---

## Verification Plan

### Automated
```powershell
# Build both apps — must exit with code 0
pnpm --filter @crimfig/web-ads build
pnpm --filter @crimfig/web-billing build
```

### Manual
1. Open [Ads Frontend](https://ads-frontend-production-49bd.up.railway.app) → Click "Create Campaign" → Spinner in submit button must animate.
2. Open [Billing Frontend](https://billing-frontend-production-4256.up.railway.app) → Click "Fund Wallet" → Spinner in submit button must animate.
3. Toggle theme switch → All cards must transition smoothly.
4. Open Browser DevTools → Console must show no `animate-spin` missing CSS warnings.
