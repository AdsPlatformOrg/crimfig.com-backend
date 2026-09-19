# Deployment Implementation Plans & Production Playbook

This directory stores serial implementation plans and architectural playbooks for deploying services and applications across the **CrimFig Ecosystem** on Railway and CI/CD platforms.

---

## Index of Plans

- [001-core-auth-and-database-migrations.md](./001-core-auth-and-database-migrations.md): Auth API, Drizzle ORM automated migrations on `crimfig_core`, and Auth Frontend.
- [002-railpack-frontends-and-microservices.md](./002-railpack-frontends-and-microservices.md): Railpack deployment guide for Next.js frontends and NestJS microservices (Billing API, Ads API, Ads Frontend, Billing Frontend, Chat, Tetris).
- [003-ads-billing-frontend-gap-fixes.md](./003-ads-billing-frontend-gap-fixes.md): Gap audit and critical fixes for ADS and BILLING app frontends — CSS token alignment, broken `animate-spin` spinner, Tailwind dead code, and auth integration strategy (HttpOnly cookie hybrid approach).
