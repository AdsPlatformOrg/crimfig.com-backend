# crimfig-backend — Serial Activity Log

All significant changes, decisions, and agent actions are recorded here in reverse chronological order.

---

## 2026-08-09

- Repo split executed: `crimfig.com/backend/` promoted to standalone `crimfig/crimfig-backend` git repository.
- `backend/shared` package created: types, DTOs, guards (CrimfigAuthGuard, RolesGuard, AppConsentGuard), decorators, CrimfigLogger.
- Phase 0 Foundation complete: all schema files, drizzle.config.ts, docker-compose.dev.yml, infrastructure scaffolding, docs.
- Architecture plan finalized (v5): two-repo split, Railway hosting, Nigeria-first launch, NDPR compliance, OAuth 2.0 + OIDC + PKCE.
- Initial scaffold: NestJS auth service with JWT, OAuth PKCE, organizations, tokens, health modules.
- Email provider: Brevo transactional API (replacing SMTP).
