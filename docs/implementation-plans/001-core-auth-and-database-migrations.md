# Implementation Plan 001: Core Auth & Automated Database Migrations

**Status**: ✅ Completed & Verified  
**Date**: September 19, 2026  
**Scope**: `AUTH-API`, `AUTH-frontend`, PostgreSQL `crimfig_core`, GitHub Actions CI

---

## 1. Objectives & Challenges
1. Ensure all Drizzle ORM migrations run automatically on Railway build/bootstrap to provision all 27 tables in `crimfig_core`.
2. Fix 404 HTTP errors on `AUTH-frontend`.
3. Establish robust GitHub Actions CI workflows for `dev` and `production` branches across frontend and backend.

---

## 2. Key Actions & Solutions Taken

### A. Database Migrations Integration
- **Issue**: Deployments without direct database migration triggers left `crimfig_core` empty with zero tables.
- **Solution**:
  - Bound direct Drizzle migration script execution directly inside `auth/src/main.ts` bootstrap sequence (`runMigrations()`).
  - Added direct dependencies (`drizzle-orm`, `pg`, `dotenv`) to `@crimfig/auth-api` and `@crimfig/shared`.
  - Configured migration files inside Docker image so they execute against the Railway PostgreSQL connection string (`DATABASE_URL`).
  - Result: 27 schema tables generated and verified on startup.

### B. Auth Frontend Routing Fix
- **Issue**: Visiting the root domain returned 404 because Next.js App Router had login at `/login` without a root page handler.
- **Solution**:
  - Created `frontend/web/auth/src/app/page.tsx` performing permanent/temporary redirect (`redirect('/login')`).
  - Verified live URL returns HTTP 307 -> 200 OK.

### C. CI / CD Workflow Configuration
- Configured `.github/workflows/ci.yml` on both backend and frontend repositories:
  - Triggers on `push` and `pull_request` to `dev`, `production`, and `main`.
  - Runs linting, typechecking, and build validation via `pnpm` and `turbo`.
