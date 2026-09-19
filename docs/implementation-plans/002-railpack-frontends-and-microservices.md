# Implementation Plan 002: Railpack Deployment Guide for Apps & Microservices

**Status**: ✅ Completed & Verified  
**Date**: September 19, 2026  
**Scope**: `BILLING-API`, `ADS-API`, `BILLING-frontend`, `ADS-frontend`, `CHAT-frontend`, `TETRIS-frontend`

---

## 1. Summary of Architecture & Deployments

| Service / App | Type | Engine / Builder | Port | Public URL | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`AUTH-API`** | Backend | Dockerfile / Alpine | 4000 | `https://auth-api-production-8e03.up.railway.app` | ✅ 200 OK |
| **`AUTH-frontend`** | Web | Railpack | 3000 | `https://auth-frontend-production-42f8.up.railway.app` | ✅ 307 -> 200 OK |
| **`BILLING-API`** | Backend | Dockerfile / Node 22 | 3008 | `https://billing-api-production-bb4c.up.railway.app` | ✅ 200 OK |
| **`BILLING-frontend`** | Web | Railpack | 3000 | `https://billing-frontend-production-4256.up.railway.app` | ✅ 200 OK |
| **`ADS-API`** | Backend | Dockerfile / Node 22 | 3004 | `https://ads-api-production-d889.up.railway.app` | ✅ 200 OK |
| **`ADS-frontend`** | Web | Railpack | 3000 | `https://ads-frontend-production-49bd.up.railway.app` | ✅ 200 OK |
| **`CHAT-frontend`** | Web | Railpack | 3000 | `https://chat-frontend-production-176c.up.railway.app` | ✅ 200 OK |
| **`TETRIS-frontend`** | Web | Railpack | 3000 | `https://tetris-frontend-production-723c.up.railway.app` | ✅ 200 OK |

---

## 2. Key Lessons & Steps for Future Deployments

### Rule 1: Railpack Next.js Frontends Port Binding
- **Issue**: By default, Railpack sets Next.js internal listen port to 8080 (or respects `$PORT`), while Railway public domains default target port 3000. If there's a mismatch, Railway's edge proxy returns `502 Application failed to respond`.
- **Action Required**:
  1. Ensure the app's `package.json` `start` script is `next start` (without hardcoding `-p <port>`).
  2. In Railway Service Variables, set `PORT=3000`. Next.js will automatically bind to port 3000 matching Railway's public edge domain targetPort.

### Rule 2: Subdirectory Monorepo Deployments with Railpack
- For frontend apps located inside `web/*`:
  - Set `rootDirectory` to `/web/<app-name>` (e.g. `/web/billing`, `/web/ads`).
  - Railpack detects the Next.js app in that folder, installs its dependencies, and runs `npm run build` and `npm start` automatically without needing a custom Dockerfile.

### Rule 3: Backend Monorepos with Workspace Dependencies
- Backend microservices (`api/billing-api`, `api/ads-api`) depend on `@crimfig/shared` and `@crimfig/database`.
- When building backend images:
  - Copy all needed workspace package definitions (`shared`, `database`, `auth`, `api/*`).
  - Ensure every microservice explicitly declares its runtime dependencies (`dotenv`, `pg`, `drizzle-orm`) in its own `package.json` so Docker builds and isolated package graphs resolve cleanly.
  - Compile workspace packages in dependency order:
    1. `@crimfig/shared`
    2. `@crimfig/database`
    3. `@crimfig/<service>-api`

### Rule 4: Payment Credentials (Paystack)
- Always configure test keys (`PAYSTACK_SECRET_KEY=sk_test_...` and `PAYSTACK_PUBLIC_KEY=pk_test_...`) in the Railway environment variables during development.
- Live keys (`sk_live_...` and `pk_live_...`) can be pasted directly into Railway variables without rebuilding images when ready for production.
