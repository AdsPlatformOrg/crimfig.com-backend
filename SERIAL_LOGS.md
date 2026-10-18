# crimfig-backend — Serial Activity Log

All significant changes, decisions, and agent actions are recorded here in reverse chronological order.

## 2026-10-18
- Normalized `AUTH_WEB_URL` and `ADS_WEB_URL` in `backend/auth/src/config/config.ts` so production environments automatically enforce `https://auth.crimfig.com` (and `https://ads.crimfig.com`), ignoring any legacy raw `*.railway.app` environment variables.
- Updated `backend/auth/src/modules/oauth/oauth.controller.ts` to use `config.APP.AUTH_WEB_URL` instead of reading `process.env.AUTH_WEB_URL` directly.
- Fixed CORS error on `https://auth.crimfig.com/signup` and cross-origin authentication requests.
- Updated `backend/auth/src/main.ts` with dynamic origin validation supporting all `*.crimfig.com` subdomains, `*.railway.app` deployment domains, and localhost ports.
- Configured Helmet with `crossOriginResourcePolicy: { policy: 'cross-origin' }` and `crossOriginOpenerPolicy: { policy: 'unsafe-none' }` to prevent cross-origin resource blocking.
- Expanded allowed preflight headers to include `X-Requested-With`, `Accept`, `Origin`, and client hint headers.
- Updated default `ALLOWED_ORIGINS` in `config.ts` to include all production web portals.

## 2026-10-17
- Completed and verified full execution of PLAN-0004 (Ads Growth Layer: Conversion Tracking & CPA Bidding, Video Transcoding, Mobile SDKs, Invalid-Traffic Disputes & Smart Targeting).
- Implemented `DisputesModule` (`DisputesService`, `DisputesController`) for self-serve advertiser and promoter traffic quality disputes and appeals with 5-day SLA tracker and immutable ledger adjustments.
- Extended database schema with `ads_disputes`, `ads_campaigns` CPA/CPCV pricing models, and generated migration `0014_ads_growth_and_disputes.sql`.
- Implemented Mobile SDK remote config, device attestation session exchange (`/delivery/app-session`), and server-verified rewarded ad callbacks (`/delivery/reward-verify`).
- Verified zero TypeScript compilation errors in `@crimfig/database` and `@crimfig/ads-api`.

## 2026-10-12
- Completed and verified full execution of PLAN-0001 and PLAN-0002.
- Implemented `BillingEcosystemClient`, `AdsEscrowService`, `AdsSettlementService`, and `AdsBillingController` in `ads-api`.
- Established fixed 55/30/15 revenue split engine (55% publisher, 30% CrimFig platform base, 15% referral/marketing pool) in `billing.constants.ts`.
- Implemented decoupled shared monetization architecture with 7 tables in `@crimfig/database` (`monetization_*`).
- Integrated 30-min settlement cron worker and promoter privacy data shielding.
- Generated Drizzle migrations `0001` through `0006`.
- Verified typecheck and production build across all 10 backend packages.

## 2026-08-09

- Repo split executed: `crimfig.com/backend/` promoted to standalone `crimfig/crimfig-backend` git repository.
- `backend/shared` package created: types, DTOs, guards (CrimfigAuthGuard, RolesGuard, AppConsentGuard), decorators, CrimfigLogger.
- Phase 0 Foundation complete: all schema files, drizzle.config.ts, docker-compose.dev.yml, infrastructure scaffolding, docs.
- Architecture plan finalized (v5): two-repo split, Railway hosting, Nigeria-first launch, NDPR compliance, OAuth 2.0 + OIDC + PKCE.
- Initial scaffold: NestJS auth service with JWT, OAuth PKCE, organizations, tokens, health modules.
- Email provider: Brevo transactional API (replacing SMTP).
