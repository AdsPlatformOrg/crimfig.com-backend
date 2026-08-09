# docs/architecture — CrimFig System Architecture

This directory contains architecture decision records (ADRs) and system diagrams.

## Contents

- `adr/` — Architecture Decision Records (numbered, e.g. `ADR-001-monorepo-structure.md`)
- `diagrams/` — System and data flow diagrams (Mermaid / draw.io)

## Key Architecture Decisions

See the implementation plan: [`crimfig.com/implementation_plan.md`](../../HA_REQUIREMENTS.md)

### Quick Reference: Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 + TypeScript |
| Mobile | React Native + Expo |
| Backend | NestJS + TypeScript |
| Database | PostgreSQL 16 + Drizzle ORM |
| Cache | Redis |
| Auth Protocol | OAuth 2.0 + OIDC (PKCE) |
| Monorepo | pnpm workspaces + Turborepo |
| Hosting | Railway (initial) → Kubernetes (scale) |
