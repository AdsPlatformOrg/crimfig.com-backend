# CrimFig Backend - Serial Logs

Prior historical entries up to 2026-11-03 are archived in `backend/SERIAL_LOGS_ARCHIVE_20261103.md`.

## 2026-11-06 - PLAN-0096 mobile candidate eligibility and trace evidence

Unified mobile device matching in upstream targeting and auction, preserved serialized/parsed targeting and stack overrides, and rejected malformed targeting. Persisted specific candidate rejections, bounded stage/device/policy context and replay-compatible paid audit metadata. Historical staging records confirm Android but lack individual candidate reasons. Current round-the-clock schedule supersedes legacy hours. Focused units passed 38 and isolated real Ads-to-Billing HTTP/PostgreSQL passed two selected cases, including three device-specific paid serves and four zero-charge House fallbacks. Deployment and live mobile render remain pending. Reports are in workspace docs/reviews/plan-0096.

## 2026-11-06 - PLAN-0097 isolated staging gateway setup

JED authorized provisioning the missing gateway. Fixed provider HTTP routes, added service health and PORT fallback, projected bank-directory fields to fit signed receipts, and deployed FINANCIAL-GATEWAY with its separate persistent PostgreSQL service. Configured Billing's matching gateway URL and keys and redeployed its existing image. The running Billing service returned 296 test-mode banks. Initial focused units passed 21 tests, the final provider suite passed 8, and the real local HTTP/PostgreSQL gateway suite passed 4 with a fake external provider. Railway Docker build and health checks passed. Gateway updates currently require a local source upload. Checkout/payment acceptance remains open. See FINANCIAL_GATEWAY.md and docs/reviews/plan-0097/gateway-staging-evidence.json in the workspace.

## 2026-11-03 - PLAN-0087 Pre-Auction Gate Tracing and Targeting Normalization
Implemented stage-aware pre-auction fallback telemetry in `delivery.service.ts` (`SLOT_TESTING_MODE`, `SLOT_INSTALLATION_PENDING`, `WEBSITE_POLICY_NOT_APPROVED`, `PLATFORM_PAID_DELIVERY_DISABLED`, `TRAFFIC_CONTROL_RESTRICTION`). Fixed `parseStringArray` and `parseNumberArray` to safely accept both pre-parsed Arrays and JSON strings. Passing test suites: `plan0085-paid-delivery-root-cause.spec.ts` (5/5), `plan0085-slot-installation-and-diagnostics.spec.ts` (4/4). Commit: `0a41a10`.

## 2026-11-11 — PLAN-0099 campaign-list column sorting

Added allowlisted sorting for title, displayed status, budget, spend, approved creatives, valid impressions/clicks and CTR in both directions before pagination; deterministic ID tie-breaker and owner/status/search scope retained. Metric sorting shares current event attribution. Regenerated Ads OpenAPI/client. Two backend units and two dedicated isolated PostgreSQL/real HTTP tests pass, including malformed input, unauthenticated requests, account separation, network-slot attribution, House/invalid exclusion and absence of ledger writes. Dedicated disposable port 25439 avoids another local test run; cleanup confirmed. Evidence: ../docs/reviews/plan-0099/backend-sort-integration-results.json and frontend/docs/reviews/plan-0099/sorting-20261111.md. No staging/deployment or external provider operation. Preserve concurrent event-attribution dependency when preparing a release.

## 2026-11-11 - PLAN-0103 jed.com.ng missing metrics and click diagnosis

Read-only staging audit confirmed 24 paid CPC serves, 20 valid impressions, 18 viewable events and two invalid DUP_CLICK events at 00:57 UTC. Network delivery has null placements; placement-only analytics excluded its events. Added shared serve-based attribution with guarded legacy fallback across advertiser summary/trend/channels and campaign totals. Removed duplicate stateful click validation from redirect, preserving assessment in ingestion. Chart spend now uses completed internal debits, and empty channel shares are zero. Unit regressions: 39 passed / 4 suites; isolated PostgreSQL + authenticated reporting HTTP, actual frontend parsing and signed click/evidence persistence: 4 passed, 74 unrelated tests filtered; existing mapper: 2 passed. Findings and machine-readable reports: workspace docs/reviews/plan-0103. Existing concurrent work preserved. No deployment, worker activation, historical event repair or charges. Both staging opportunity worker flags disabled; placement-bound network settlement and worker enum comparisons remain readiness gates. Plan stays IN_PROGRESS.

## 2026-11-11 - PLAN-0103 network settlement

Added funded network settlement with signed event and assessment checks, exact carry accounting, atomic reservation closure, and worker enum fixes. Six selected disposable PostgreSQL regressions passed. Railway confirmed reporting revision 2e15b0b on Ads and Billing staging. Both worker flags are off. Settlement deployment and funded staging acceptance remain pending. Evidence: docs/reviews/plan-0103.

## 2026-11-11 - PLAN-0102 daily Ads reports

Added owner-scoped daily CPC and CPM reports with exact event nanos, separate ledger postings, and promoter receipt and recovery states. Three units and two isolated HTTP/PostgreSQL and consumer contract cases passed. Ads API typecheck passed. Browser and staging acceptance pending.

## 2026-11-11 - PLAN-0104 staging release

Applied migration 0040 after matching 39 prior hashes. Ads API deployed b2ec295. Exact staging receipt reconciliation returned 6 observed, 1 valid and 0 billed. The test event is validated with a journal and a claimed reservation, pending final assessment. Dashboard fixture correction d95d635 passed 3 focused tests. See ../docs/reviews/plan-0104/staging-release.md.
