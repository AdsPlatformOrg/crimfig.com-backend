# backend/shared — CrimFig Shared Backend Package

**Package:** `@crimfig/shared`
**Purpose:** Common TypeScript types, DTOs, Auth Guards, and utilities shared across all NestJS backend services.

## Contents
- `src/types/` — Shared TypeScript interfaces and enums
- `src/guards/` — NestJS `CrimfigAuthGuard`, `AppConsentGuard`, `RolesGuard`
- `src/decorators/` — `@CurrentUser()`, `@Roles()`, `@RequireAppConsent()`
- `src/dto/` — Common request/response DTOs
- `src/logger/` — Structured JSON logger (wraps NestJS logger with audit fields)
