# backend/auth — CrimFig Auth API (NestJS)

**Service:** `auth.crimfig.com/api`
**Framework:** NestJS + TypeScript
**Purpose:** Central OAuth2/OIDC server — handles all authentication, authorization, token issuance, MFA, Organization management, and App Consent flows.

## Key Modules (Phase 1)
- `AuthModule` — Login, Sign Up, Email verification
- `OAuthModule` — `/oauth/authorize`, `/oauth/token`, `/oauth/userinfo`
- `OrganizationModule` — Multi-Owner org management, quorum voting
- `MfaModule` — TOTP, FIDO2/WebAuthn passkeys
- `ConsentModule` — App-specific Terms acceptance

## Setup
```bash
pnpm install && pnpm dev
```
