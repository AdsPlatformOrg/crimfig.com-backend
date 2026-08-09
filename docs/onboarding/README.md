# docs/onboarding — Developer Onboarding Guide

## Prerequisites
1. **Node.js 20 LTS** — use [nvm](https://github.com/nvm-sh/nvm) or install from nodejs.org
2. **Corepack** — enables pnpm enforcement: `corepack enable`
3. **pnpm 9+** — verified automatically via Corepack

## First-time Setup
```bash
# 1. Enable Corepack (run once per machine)
corepack enable

# 2. Clone the repo
git clone git@github.com:crimfig/crimfig-ecosystem.git
cd crimfig-ecosystem

# 3. Install all workspace dependencies
pnpm install

# 4. Copy .env.example to .env in each service you are working on
cp backend/database/.env.example backend/database/.env
cp backend/auth/.env.example backend/auth/.env
# Fill in the values for your local environment

# 5. Start a specific app in dev mode
pnpm --filter @crimfig/auth-web dev     # frontend/web/auth
pnpm --filter @crimfig/auth-api dev     # backend/auth
```

## ⚠️ IMPORTANT: Use pnpm only
npm and yarn are **blocked** in this repository. Any attempt to run `npm install` or `yarn` will fail immediately. Always use `pnpm`.

## Commit Signing
All commits to `main` require GPG signing. See `docs/security/signing-setup.md` for setup instructions.
