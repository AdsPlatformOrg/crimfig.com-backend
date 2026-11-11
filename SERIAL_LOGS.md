# CrimFig Backend - Serial Logs

Prior historical entries up to 2026-11-03 are archived in `backend/SERIAL_LOGS_ARCHIVE_20261103.md`.

## 2026-11-03 - PLAN-0087 Pre-Auction Gate Tracing and Targeting Normalization
Implemented stage-aware pre-auction fallback telemetry in `delivery.service.ts` (`SLOT_TESTING_MODE`, `SLOT_INSTALLATION_PENDING`, `WEBSITE_POLICY_NOT_APPROVED`, `PLATFORM_PAID_DELIVERY_DISABLED`, `TRAFFIC_CONTROL_RESTRICTION`). Fixed `parseStringArray` and `parseNumberArray` to safely accept both pre-parsed Arrays and JSON strings. Passing test suites: `plan0085-paid-delivery-root-cause.spec.ts` (5/5), `plan0085-slot-installation-and-diagnostics.spec.ts` (4/4). Commit: `0a41a10`.

## 2026-11-11 - PLAN-0103 jed.com.ng missing metrics and click diagnosis

Read-only staging audit confirmed 24 paid CPC serves, 20 valid impressions, 18 viewable events and two invalid DUP_CLICK events at 00:57 UTC. Network delivery has null placements; placement-only analytics excluded its events. Added shared serve-based attribution with guarded legacy fallback across advertiser summary/trend/channels and campaign totals. Removed duplicate stateful click validation from redirect, preserving assessment in ingestion. Chart spend now uses completed internal debits, and empty channel shares are zero. Unit regressions: 39 passed / 4 suites; isolated PostgreSQL + authenticated reporting HTTP, actual frontend parsing and signed click/evidence persistence: 4 passed, 74 unrelated tests filtered; existing mapper: 2 passed. Findings and machine-readable reports: workspace docs/reviews/plan-0103. Existing concurrent work preserved. No deployment, worker activation, historical event repair or charges. Both staging opportunity worker flags disabled; placement-bound network settlement and worker enum comparisons remain readiness gates. Plan stays IN_PROGRESS.
