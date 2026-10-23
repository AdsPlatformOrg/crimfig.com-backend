# Editing browser origins

Edit `cors-origins.json` in this directory. The APIs share this versioned file;
no Railway origin-list environment variable is needed.

- `production`: exact HTTPS origins for first-party websites and approved Railway frontends.
- `development`: additional exact loopback origins, included only outside production.

Use an origin such as `https://billing.crimfig.com`: no path, wildcard, credentials,
backslash, query string or fragment. Keep valid JSON, with commas between entries.
Rebuild and deploy the backend after editing; the file is included in the compiled shared package.

Public Ads delivery keeps its separate cookie-free CORS policy. Editing this file
does not grant publisher sites access to private dashboard APIs.

Public Ads routes (`/api/v1/delivery/*`, `/api/v1/px.js`, `/api/v1/px/collect`,
`/api/v1/uploads/media/:id`, and `/api/v1/campaigns/catalog`) accept cross-origin
requests from arbitrary publisher sites without cookies. The Ads dashboard and
management routes use this allowlist and require authenticated access. A separate
delivery hostname is optional; the current API separates these policies by route.
