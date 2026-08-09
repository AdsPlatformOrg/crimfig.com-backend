# backend/audit — CrimFig Audit Microservice (NestJS)

**Framework:** NestJS + TypeScript
**Purpose:** Centralized audit and security event logging microservice. All other services publish events to this service via NATS. This service persists events to the `audit_logs` table and can forward to external SIEM systems.

## Setup
```bash
pnpm install && pnpm dev
```
