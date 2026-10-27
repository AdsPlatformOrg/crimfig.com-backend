# crimfig-backend — Serial Activity Log

All significant changes, decisions, and agent actions are recorded here in reverse chronological order.

## 2026-10-22
- **Subscriptions `cancelSubscription`**: Refactored to conditional atomic `cancelAtPeriodEnd = true` update for active/trialing/past_due subscriptions, preserving customer access until the end of the paid billing period. Idempotent return without mutation if already ended; owner-scoped with `NotFoundException`.
- **Operator Withdrawal Refund Fee Reconciliation**:
  - Implemented `WithdrawalLedgerService.registerRefundEvidence` and `WithdrawalsService.registerRefundEvidence` with atomic transaction advisory locking (`withdrawal:<ref>`).
  - Enforced dual distinct operator requirement (`preparedBy !== reviewedBy`), strict transfer code & domain validation, and bounded retained charges (`retainedFeeKobo <= payoutQuote.transferFeeKobo`, `retainedStampDutyKobo <= payoutQuote.stampDutyKobo`).
  - Stored immutable receipt in `billing_provider_events` under namespace `internal.withdrawal.refund:<ref>` with `processed = true`.
  - Exposed `POST /api/v1/withdrawals/:reference/refund-evidence` with `RegisterRefundEvidenceDto` in `withdrawals.controller.ts`.
- **Typing & Test Infrastructure Fix**: Added `"types": ["jest", "node"]` to `backend/auth/tsconfig.spec.json` and explicit `@jest/globals` declarations in `unavailable-payments.spec.ts` resolving editor language-server errors.
- **Verification Matrix**:
  - `pnpm --filter @crimfig/auth-api test -- unavailable-payments` -> 10/10 PASS.
  - `pnpm --filter @crimfig/auth-api test -- cards-and-revenue-split` -> 20/20 PASS.
  - `pnpm --filter @crimfig/billing-api build` & `lint` -> PASS.
  - `pnpm --filter @crimfig/ads-api build` & `lint` -> PASS.
  - `pnpm --filter @crimfig/session test` -> 74/74 PASS.
  - `pnpm --filter @crimfig/web-billing build` & `@crimfig/web-ads build` -> PASS.


- Continued PLAN-0009: transactional refresh-family rotation/logout with advisory locking, preserved app/family, bounded 409 collision and actual signed access expiry.
- Added reusable bearer verifier and exact dashboard origins; Billing registers a default-deny guard, checks current account status and removes controller demo/header identity fallback.
- Owner-scoped funding verification; explicit ecosystem service key in every environment; configured raw-body Paystack signatures without development bypass/default key.
- Added local HTTP/ownership/callback/concurrency regression fixtures. All 36 backend tests across six suites pass; Shared TypeScript and Auth/Billing Nest builds pass; targeted lint passes.
- Updated only two locked JWT importers from an existing resolution after offline re-resolution lacked unrelated metadata. No dependency versions changed.
- Ads authorization/role ownership and frontend integration remain pending; no production/migration/provider/payment actions executed.

## 2026-10-18
- Fixed 500 Internal Server Error on `POST /api/v1/auth/login`. Added auto-provisioning for `crimfig_auth` (and ecosystem apps) in `TokensService.issueTokenPair`, preventing `TypeError: Cannot read properties of undefined (reading 'id')` when apps are unseeded.
- Safely guarded `app` and `user` against null in `TokensService.issueTokenPair` and `TokensService.issueMfaChallengeToken`.
- Auto-seeded core first-party ecosystem apps (`crimfig_auth`, `crimfig_ads`, `crimfig_billing`, `crimfig_chat`, `crimfig_reels`, `crimfig_stream`, `crimfig_tetris`) in `backend/database/src/migrate.ts` upon migration execution.
- Added comprehensive unit test suites in `auth.service.spec.ts` and `tokens.service.spec.ts` covering login flows, token issuance, MFA challenges, missing app auto-provisioning, and credential checks.
- Normalized `AUTH_WEB_URL` and `ADS_WEB_URL` in `backend/auth/src/config/config.ts` so production environments automatically enforce `https://auth.crimfig.com` (and `https://ads.crimfig.com`), ignoring any legacy raw `*.railway.app` environment variables.
- Updated `backend/auth/src/modules/oauth/oauth.controller.ts` to use `config.APP.AUTH_WEB_URL` instead of reading `process.env.AUTH_WEB_URL` directly.
- Fixed CORS error on `https://auth.crimfig.com/signup` and cross-origin authentication requests.
- Updated `backend/auth/src/main.ts` with dynamic origin validation supporting all `*.crimfig.com` subdomains, `*.railway.app` deployment domains, and localhost ports.
- Configured Helmet with `crossOriginResourcePolicy: { policy: 'cross-origin' }` and `crossOriginOpenerPolicy: { policy: 'unsafe-none' }` to prevent cross-origin resource blocking.
- Expanded allowed preflight headers to include `X-Requested-With`, `Accept`, `Origin`, and client hint headers.
- Updated default `ALLOWED_ORIGINS` in `config.ts` to include all production web portals.

## 2026-10-17
- Completed and verified full execution of PLAN-0004 (Ads Growth Layer: Conversion Tracking & CPA Bidding, Video Transcoding, Mobile SDKs, Invalid-Traffic Disputes & Smart Targeting).
- Implemented `DisputesModule` (`DisputesService`, `DisputesController`) for self-serve advertiser and promoter traffic quality disputes and appeals with 5-day SLA tracker and immutable ledger adjustments.
- Extended database schema with `ads_disputes`, `ads_campaigns` CPA/CPCV pricing models, and generated migration `0014_ads_growth_and_disputes.sql`.
- Implemented Mobile SDK remote config, device attestation session exchange (`/delivery/app-session`), and server-verified rewarded ad callbacks (`/delivery/reward-verify`).
- Verified zero TypeScript compilation errors in `@crimfig/database` and `@crimfig/ads-api`.

## 2026-10-12
- Completed and verified full execution of PLAN-0001 and PLAN-0002.
- Implemented `BillingEcosystemClient`, `AdsEscrowService`, `AdsSettlementService`, and `AdsBillingController` in `ads-api`.
- Established fixed 55/30/15 revenue split engine (55% publisher, 30% CrimFig platform base, 15% referral/marketing pool) in `billing.constants.ts`.
- Implemented decoupled shared monetization architecture with 7 tables in `@crimfig/database` (`monetization_*`).
- Integrated 30-min settlement cron worker and promoter privacy data shielding.
- Generated Drizzle migrations `0001` through `0006`.
- Verified typecheck and production build across all 10 backend packages.

## 2026-08-09

- Repo split executed: `crimfig.com/backend/` promoted to standalone `crimfig/crimfig-backend` git repository.
- `backend/shared` package created: types, DTOs, guards (CrimfigAuthGuard, RolesGuard, AppConsentGuard), decorators, CrimfigLogger.
- Phase 0 Foundation complete: all schema files, drizzle.config.ts, docker-compose.dev.yml, infrastructure scaffolding, docs.
- Architecture plan finalized (v5): two-repo split, Railway hosting, Nigeria-first launch, NDPR compliance, OAuth 2.0 + OIDC + PKCE.
- Initial scaffold: NestJS auth service with JWT, OAuth PKCE, organizations, tokens, health modules.
- Email provider: Brevo transactional API (replacing SMTP).

## 2026-10-21 — PLAN-0009 Ads Billing boundary follow-up
- Removed fabricated wallet balances and successful acknowledgements on Billing errors.
- Corrected Billing route/default port and validated real nested wallet responses; retain zero.
- Required explicit internal key; reject redirects; bounded requests; no automatic write retries.
- Added 18 mocked-fetch regression tests and service rollout/reconciliation documentation.
- Ads Nest build and targeted lint pass. No payments, migrations or deployment executed.
- PLAN-0009 remains IN_PROGRESS: Ads auth/roles/ownership and frontend wiring remain pending.
- Recorded existing settlement/clearance duplicate-credit and partial-failure reconciliation gates.

## 2026-10-21 — PLAN-0009 Ads authorization follow-up
- Installed verified access/current-account guard; removed controller header/demo identities.
- Added explicit server-managed staff grants (default none), scoped staff actions and blocked normal self-review.
- Added campaign/escrow/dispute owner checks and placement resource binding; owner status cannot bypass moderation.
- Public approved media and private owner-preview routes; public pixel telemetry cannot earn attribution or reserve order keys.
- Required scoped/current-owner S2S key authentication and advertiser-bound click attribution.
- Exact private CORS and cookie-free public CORS; corrected duplicated controller prefixes.
- Ads build/typechecks/lint pass; 83 tests passed across nine suites before three additional key/attribution tests.
- No live grants, DB migrations, payment/Firebase/provider requests or deployment. Frontend/staging/settlement gates remain.
- Final follow-up verification: ownership/key suite expanded to 14 passing cases after combined 83-test run (86 distinct tests covered); owner/staff preview UI wiring remains a rollout gate.

## 2026-10-21 — PLAN-0009 Auth refresh CORS integration
- Removed broad credentialed Railway/subdomain/localhost regex admission from Auth.
- Reused exact-origin validation; production defaults omit localhost, development defaults include dashboard port 3007; preview origins require explicit configuration.
- Removed ineffective Set-Cookie exposure header (cookies remain HttpOnly). Cookie scope unchanged.
- Frontend dashboard session/login integration and remaining rollout gates are recorded in docs/architecture/PLAN-0009-dashboard-session-integration.md.
- Auth exact-origin follow-up verification: Auth Nest build/lint and all 86 backend tests across nine suites pass; real authenticated cross-subdomain staging remains open.

## 2026-10-21 — PLAN-0009 media preview/API contract follow-up
- Added staff review-media route with explicit moderation grants; public query parameters cannot bypass approval and finance alone cannot preview review assets.
- Owner/public media rules unchanged. Queue includes video URLs; escrow overview exposes actual record/refund/burn fields for frontend accounting.
- All 87 backend tests pass including protected preview controller integration with mocked storage; Ads Nest build and targeted lint pass. No real storage/payment/database/migration/deployment operations.

## 2026-10-21 — PLAN-0009 bank-resolution boundary
- Account-holder resolution now requires verified current-account bearer authentication; supported-bank directory remains public.
- All 10 targeted Billing security/preflight tests pass including public-directory/private-resolution behavior; Billing Nest build and targeted lint pass. Provider service mocked in tests.
- Existing website-verification fetch/redirect behavior was identified as a concrete outbound-network hardening gate before rollout; no DNS/provider/live account/migration/deployment actions executed.


## 2026-10-21 — PLAN-0009 website verification hardening (ACT-20261021-015)
- HTTPS registered-domain root only; credentials/custom ports/paths/queries/fragments rejected, including legacy records. DNS TXT requires exact joined record, not token substrings.
- HTML fetch validates every DNS answer, rejects non-public/unsupported addresses, pins selected IPv4 in HTTPS lookup with hostname/SNI validation retained, no redirect following or shared agent.
- DNS deadline 2s; request absolute deadline 5s; HTML-only identity encoding; streamed body capped at 512KiB. Exact quoted meta proof, inactive/raw-text markup ignored; failed verification clears stale verifiedAt. Ownership predicate retained on updates; sanitized client errors.
- Conservative limitation: HTML verification rejects all IPv6 answers (including mixed A/AAAA), redirecting/non-root sites and unsupported meta syntax. DNS TXT remains available for valid registered HTTPS domains. No claim of general HTML parser compatibility or mobile-app attestation.
- 41 focused mocked DNS/HTTPS/service tests pass; Ads Nest build, targeted lint and backend diff whitespace check pass. No real DNS/provider calls or deployment; frontend unchanged.
- PLAN-0009 remains IN_PROGRESS. Next: authoritative financial idempotency/reconciliation; logout coordination and real staging. Auth build issue from user attachment fac5d98e-3de4-4a99-8494-9791ec8c547c/Pasted text.txt deferred at user request, not investigated/fixed here.


## 2026-10-21 — PLAN-0009 authoritative escrow and unsafe settlement quarantine (ACT-20261021-016)
- Billing CampaignEscrowService now owns wallet + escrow + owner campaign-status transitions in one READ COMMITTED transaction: campaign advisory/row locks, escrow/wallet locks, bounded DB waits, guarded cents and durable unique Billing receipts. Ads proxies confirmed writes and retains reads; same-generation repeats do not move funds again. Pause/reactivation retains cumulative reservation/refund history.
- Manager approval/emergency override leaves campaigns approved/paused (live false); activation must atomically confirm funding. The manager button text now says Approve Campaign with existing design retained.
- Removed unsafe settlement/clearance/financial audit bodies (first-promoter payout, duplicate clearance credit, unrelated-campaign rebates, simulated penalties). Manual actions and old generic internal wallet writes return 503; those financial cron calls are disabled. Historical finance reads remain. Public embed pings no longer auto-verify website/app ownership.
- Existing unreceipted/duplicate escrow records fail closed for reconciliation. Prepared docs/architecture/PLAN-0009-financial-reconciliation.sql, NOT executed. No automatic repair/adoption/reversal/backfill payment. Shared Ads/Billing PostgreSQL topology, uniqueness and coordinated release are required.
- Full backend suite passed 146 tests; final escrow/moderation guard additions verified in 34 focused tests. 40 frontend tests pass. Ads/Billing Nest builds, Ads frontend production build/types, targeted backend/frontend lint and whitespace checks pass; existing frontend toolchain notices only.
- Actual moderation component rendered using compiled app CSS with fake state, no APIs: corrected label checked in light/dark desktop and narrow disabled layouts. Narrow toolbar crowding is pre-existing and remains a UI follow-up; no sidebar/design restructure. Fixture servers stopped and temporary file removed; viewport restored.
- Remaining: real PostgreSQL multi-connection/lock/timeout verification, legacy financial reconciliation, accurate attributed event claims/pricing/windows, funded pending-to-available settlement and penalty/rebate recovery, funding/withdrawal/subscription state machines, explicit request/generation preconditions before any automatic write retry, logout coordination and real staging. Existing withdrawal WalletService methods and manual mobile verification remain unverified legacy paths. Auth build attachment remains deferred.
- PLAN-0009 IN_PROGRESS; order 0009 -> 0010 -> 0008, PLAN-0011 DRAFT. No actual accounts, provider/DNS/storage calls, historical data mutation, schema changes, migrations or deployment.


## 2026-10-21 — PLAN-0009 atomic funding completion (ACT-20261021-018)
- Pending version-2 intent/reference/quote is persisted before checkout initialization; explicit reference/NGN sent, exact checkout acknowledgement checked, ambiguous errors retain reference for reconciliation. Saved-card charging fails closed with no fallback.
- Owner verification and signed charge callbacks share locked, atomic wallet credit/completed receipt/version/balance snapshots; exact reference, stored NGN amount/currency, key domain, owner/transaction metadata and customer email checked. Historical pending records require reconciliation; completed rows never receive another credit. Unknown/non-success results do not overwrite a concurrent completion as failed.
- Charge event identity scoped by event type; unknown intent remains retryable, duplicate/acknowledgement-failure retries cannot re-credit. Unvalidated subscription activation shortcut removed. Optional explicit-consent card saving is separately locked after commit and cannot roll back or repeat a credit.
- Full backend suite: 178 tests pass across 12 suites, including 30 new funding cases. Billing Nest build, targeted lint and whitespace checks pass. Transaction adapters/providers mocked; existing HTTP tests loopback only. No frontend code changes in this slice.
- See docs/architecture/PLAN-0009-funding-completion-contract.md for provider references, route/configuration/receipt details and limitations. Real PostgreSQL/provider sandbox/staging, funding return/reconciliation UI, initialization request identity, FX source/freshness, legacy money repair, withdrawals/subscriptions/funded Ads settlement and logout remain gates. Auth build attachment deferred. No live financial/provider/database changes, migrations or deployment.


## 2026-10-21 — PLAN-0009 durable funding initialization/recovery (ACT-20261021-020)
- Funding POST requires UUID v4 requestId; owner-scoped SHA256 reference, locked insert claim and immutable amount/consent/email/callback/mode binding. Only the creator initializes Paystack; repeated/concurrent calls recover without another provider/FX call. Unique existing reference/metadata used; no migration.
- Owner-only GET funding-requests/:requestId performs recovery with no provider mutation. Pending-ready returns validated checkout; ambiguous-started stays blocked; completed never returns checkout. Checkout persistence shares completion lock/re-reads metadata so early callbacks retain receipt/completed state.
- Console persists opaque funding_request before submission, recovers on reload and resumes existing checkout only on explicit action. Explicit owner 404 permits submission under the SAME ID; invalid/conflicting parameters rejected; no credentials stored in URL/localStorage. Missing secure UUID capability fails before POST.
- Final checks: all 184 backend tests/12 suites and 53 frontend tests pass; Billing API Nest/frontend production builds, separate post-build tsc, targeted backend/frontend lint and whitespace checks pass. Existing frontend toolchain notices only. Transaction/provider mocks and loopback fixtures only; no real database/provider/FX accounts or funds.
- Actual-app browser: repeated recovery and reload show original checkout with new funding disabled, real zero balances preserved, mobile width 370 <= viewport 375, light/dark inspected. Fixture counters: five GET recoveries, ZERO checkout POSTs. No provider navigation performed. Screenshot saved; preview servers/script removed, theme/viewport restored.
- Remaining: real PostgreSQL constraints/interleavings/crash/timeout proof, provider/browser staging, richer persistent/operator reconciliation and FX policy, historical financial repair, funded settlement/withdrawal/subscription state machines, logout/cross-tab and remaining UI/copy gates. Crash before dispatch or before ready persistence intentionally does not reinitialize; no automatic expiry/replacement ID. Cross-device request discovery not implemented.
- JED authorized merge to dev, then production, then push origin AFTER PLAN-0009 completion. No merge/push now; plan remains IN_PROGRESS. Approved order 0009 -> 0010 -> 0008; 0011 DRAFT/0012 PRE-DRAFT unchanged. No live operations/migrations/deployments. Auth build attachment deferred.


## 2026-10-21 — PLAN-0009 FX integrity, appearance/honesty and real funding PostgreSQL checks (ACT-20261021-022)
- JED reiterated approval/execution for every PLAN-0009 phase; retained existing approval and conditional dev -> production -> push origin AFTER completion. No phase permission requested; plan remains IN_PROGRESS.
- FX now accepts only successful USD provider data with finite positive NGN, provider update age and persisted retrieval age <24h/nonfuture. Persist actual exchangerate_api identity and canonical six-decimal quote; same snapshot/rate ID used in conversion. No hardcoded/emergency/stale rate substitution or embedded fallback key; optional configured keyed fallback only. Bounded redirect-rejecting requests, shared refresh flight, no key/URL error logs. Historical unproven rows rejected. Provider docs checked; economics/license/custody/expiry still rollout gates.
- FX routes now authenticated; manual refresh 503 until operator/rate-limit controls. History limited 1–100 and excludes raw responses; conversion rejects fractional/truncated/conflicting/unsafe minor units and preserves zero. Withdrawal creation and subscription charging explicitly fail at service entry before side effects. Signed transfer callbacks return retryable unavailable without unsafe legacy balance writes/processed acknowledgement; funding charge path preserved, unknown signed events ignored. Financial state machines are NOT completed by quarantine.
- Actual downloaded Poppins variable wired into both app font tokens; synchronous theme bootstrap validates light/dark before content, defaults light, tolerates blocked storage. Duplicate theme controls and storage events synchronize, listeners cleaned, aria-pressed added. Ads resolves console routing before public landing render. Remaining alert popups replaced with existing accessible feedback; existing moderation toolbar wraps/loading heading honest. Billing landing navbar wraps/reserves actual height.
- Corrected unsupported Billing/Ads landing payout/latency/SLA/certification/current-FX/automatic-verification and rewards claims. Simulations/hypothetical pricing and points explicitly labeled; no example amounts credited as account funds. Unsupported SDK/mobile/settlement availability described honestly; PLAN-0010 installation and PLAN-0008 rewards not implemented here. Broader copy/DTO/a11y inventory remains open.
- Final verification: 204 backend tests/14 suites (including 13 FX cases, 3 FX HTTP cases, 4 unavailable-payment cases); 62 frontend tests (2 new invalid/blocked theme bootstrap cases). Billing Nest build, final Ads/Billing frontend builds and separate post-build types, targeted backend/frontend lint and whitespace pass. Existing frontend toolchain notices only. Early sandbox-only full HTTP suite had EACCES; authorized loopback run passed. No dependencies/version changes.
- Real PostgreSQL: elevated read-only discovery found PostgreSQL 17 service running; existing local server login required unavailable credentials and was not changed. Installed binaries started a separate random-password SCRAM temporary cluster on 127.0.0.1:25432. Dedicated plan0009_test, real pg pools/Drizzle/selected schema constraints, three distinct backend PIDs. Seven funding tests PASS: same-intent one credit, different intents sharing wallet, trigger failure rollback/retry, reference uniqueness, concurrent init one provider call, ambiguous recovery across service instances, real advisory lock timeout ~5s/no money write. Initial fake checkout lacked access_code; fixture corrected and await-all cleanup added, final run passes. No existing/prod schema migration or real provider. Actual Auth/escrow PostgreSQL/process-crash/provider/cookie staging remain open.
- Actual-app mock browser: saved dark survives reload; header/footer controls synchronized; generated Poppins font family applied; Billing landing and Ads moderation in light/dark narrow layouts fit (370px document <=375px viewport). Data/provider fixture only; Ads analytics intentionally unavailable. UI fixtures stopped/removed, appearance/viewport reset. Temporary PG stopped; exact verified temp directory/password/data and workspace pointer removed. Screenshot retained.
- Current acceptance matrix: docs/architecture/PLAN-0009-acceptance-checkpoint.md. Remaining: operator/historical reconciliation, funded attributed settlement, payout/subscription state machines, real Auth/campaign escrow PostgreSQL/crash tests, real multi-origin/cookie/storage/provider staging, complete DTO/OAuth/accessibility/reduced-motion/copy audits. Auth build attachment deferred. Plan order 0009 ->0010 ->0008; 0011 DRAFT/0012 PRE-DRAFT unchanged. No live funds/accounts, existing database writes, merge, push or deployment.


## 2026-10-21 — PLAN-0009 real PostgreSQL Auth/escrow checks (ACT-20261021-023)
- Bounded Auth rotate/revoke family lock waits (5s lock/8s statement), preserving commit-before-rejection and no auto retry. Updated memory adapter to distinguish timeout statements from advisory locks.
- Expanded opt-in real pg/Drizzle suite from 7 to 16: 6 session cases (single successor/409, logout race, insert rollback, late replay/family isolation, suspended/foreign-owner checks, actual lock timeout) and 3 escrow cases (one reserve/release and atomic status, competing campaign insufficient funds, trigger-injected status rollback). Actual selected schema constraints; minimal users/apps fixtures, fake providers/test JWT config. Three separate backend connections confirmed; no production migration.
- Final 16 PostgreSQL cases pass separately. Final sequential general regression suite: 204 pass, 16 explicitly opt-in skipped; 220 distinct backend cases covered. Auth Nest build, targeted lint and whitespace pass. Fixture SQL quoting corrected; overlapping cold test/build run hit HTTP timeout, final sequential run resolved without weaker assertions/longer tests. Frontend unchanged; prior 62 tests/build/browser evidence not rerun in this slice. User-reported separate Auth Railway build attachment remains deferred.
- New random-password SCRAM PG17 cluster on loopback 25432 only; existing server/data/config untouched. Cluster stopped, validated temporary directory/password/data and workspace pointer removed. No provider/real user/funds/existing DB writes, migration, merge, push or deployment.
- Acceptance checkpoint updated: basic real PG Auth/escrow gate now evidenced; process-crash/deployed schema/real cookie and provider staging, cross-subdomain revocation, remaining financial/operator/DTO/OAuth/a11y work remain. Plan IN_PROGRESS; every phase approved, conditional dev ->production ->push after completion retained. Order/0011 DRAFT/0012 PRE-DRAFT unchanged.


## ACT-20261022-001 — consent bearer continuation and conversion currency honesty

Auth consent now recovers through the existing shared memory-only session client at the Auth page's
exact origin. Refresh uses its first-party cookie; approval sends bearer to the Auth proxy only, with
cookies omitted by the protected-request contract. Callback never receives the bearer. One explicit
approval attempt per mounted page prevents double click and uncertain write replay. Missing/duplicate
parameters, unsupported response type, unsafe callback scheme/credentials/fragment and mismatched
code/state responses fail closed. Only HTTPS or HTTP loopback callbacks are supported by this UI;
custom native-app schemes require a separate reviewed contract. Backend still validates registered
client/callback before issuing a code. This does not certify the full OAuth scope/PKCE/Redis lifecycle.

Conversion ingest preserves explicit zero and rejects negative/nonfinite/unsafe micro-unit values.
Non-USD amounts no longer receive an invented 1:1 USD normalization. Original currency/value retained;
USD normalization stays null without a validated conversion. Historical non-USD normalization is not
automatically repaired: frontend excludes it from USD display rather than treating it as audited FX.
Frontend validates micro-unit amounts, keeps missing values null and shows unavailable aggregate USD
revenue/CPA when incomplete. A genuine USD zero renders $0.00. Conversion loading has a status instead
of initially flashing zero metrics. Removed unsupported signed-click, guaranteed clearance/dedupe,
automatic wallet clawback and settled/released claims. A hold timestamp is not a settlement receipt.

Verification: 212 general backend tests PASS (16 opt-in PG skipped); 67 frontend tests PASS; final Auth
and Ads production builds PASS; separate post-build types PASS; Ads Nest build, targeted backend/frontend
lint and whitespace PASS. Prior 16 real PostgreSQL cases remain earlier evidence, not rerun here.
Initial Auth sandbox output-directory EPERM resolved by authorized build; inferred optional-field type
corrected before final passing build. Existing toolchain notices remain.
Actual-app loopback fixtures: consent success reaches synthetic callback with exact code/state; failure
shows explicit alert and disabled repeat action. Counts: two refreshes/two approvals, bearer present;
no real registration/permission/provider. Conversion component shows zero as $0.00, non-USD/missing USD
as dash and incomplete totals unavailable; loading status and unconfirmed settlement text inspected.
Screenshots saved; both temporary servers/scripts and Ads fixture route removed; fixture tabs closed.
No new cross-browser/assistive-technology/mobile-theme certification claimed.

JED requires approved plans to run to completion without per-phase approval; policy recorded in plans
README (ACT-20261021-026). Execution continues autonomously. Two material inputs requested, not phase
approval: identify non-production staging configuration/test accounts/payment+storage sandbox for real
acceptance; resolve original dashboard scope (unsupported actions honestly disabled) versus later
checkpoint requirements for a complete financial settlement/payout/subscription engine before merge.
No staging descriptor was found in repository filename discovery; existing Auth/database env values
were not printed and are not assumed to be staging. Do not use production credentials for tests.
Plan remains IN_PROGRESS, all phases approved, conditional dev -> production -> origin not executed.
No live account/provider/funds/database operations, migrations, merge/push or deployment.


## ACT-20261022-002 — Docker verification and withdrawal ledger foundation

JED resolved both material questions: use Docker Desktop for isolated local verification and require
COMPLETE financial engine implementation before PLAN-0009 completion. Disabled actions alone cannot
satisfy completion. Every phase remains approved; no stage-by-stage approval is needed. Full financial
engine scope includes funded attributed settlement/clearance, withdrawal dispatch/reconciliation and
subscription charge/renewal/completion, plus operator/historical reconciliation and required evidence.

Docker Desktop runs; initial named-pipe access denial was sandbox-specific. Separate random-named,
label-owned PostgreSQL 16/Redis 7 containers use loopback ports and generated in-memory passwords.
Normal dev Compose/existing PostgreSQL/containers/volumes untouched. Cached tags were listed but not
resolvable by tag; explicit official pulls repaired them. New backend/scripts/plan0009-docker-test.cjs
uses cached images only, rejects remote-context/URL overrides, tests Redis auth and removes only its
new containers/anonymous volumes after exact ownership-label checks. No secrets printed or saved.
See docs/architecture/PLAN-0009-docker-verification.md for execution and limitations.

Implemented unexposed WithdrawalLedgerService and deterministic transfer state/proof rules:
- Atomic available-to-locked reservation with UUID request binding, one provider reference, current
  ACTIVE owner/verified owned bank recipient, persisted validated fresh FX, integer kobo rounding,
  bounded locks and immutable amount/bank/domain identity on duplicate requests.
- Provider evidence binds reference, recipient, amount, currency, mode and transfer code. Success
  consumes reserved principal once; failure/reversal refunds once; post-success reversal preserves
  unrelated reserves. Contradictory terminal outcomes and unversioned historical records fail closed.
- Wallet/request/receipt complete or roll back together. No provider network calls inside transactions.
  Ledger is NOT registered/exposed yet: dispatch, owner recovery, authenticated callbacks and operator
  reconciliation remain required before payout activation. Existing service/routes still unavailable.

Verification: final general backend suite 243 PASS, 24 opt-in skipped; 24 real PostgreSQL cases passed
separately in Docker (267 distinct backend cases). Includes 31 state/evidence cases and eight real
withdrawal concurrency/rollback/no-overdraw/owner/FX cases added to prior 16 PG cases. Billing Nest
build, targeted lint, JS syntax and whitespace pass. Initial user query selected unneeded full-schema
columns against minimal users fixture; narrowed to ID/status, final tests passed. Earlier runner ESLint
Node-global declarations corrected. No frontend changed: prior 67 cases/browser/builds remain earlier
evidence. Redis auth/readiness is not OAuth lifecycle or an all-service staging deployment.

Paystack official transfer lifecycle/API docs checked: references are bound, statuses asynchronous,
reversal can follow success. Real TEST-mode provider/storage acceptance still requires dedicated
configuration; requested local path/secret-entry name, never a pasted key. Docker cannot reproduce the
external provider. No live payment/provider account/user operations, existing DB writes, migration,
merge/push or deployment. Plan remains IN_PROGRESS; full-engine and staging gates remain open.


## ACT-20261022-003 — private local-docker provider configuration

Created backend/local-docker as requested, with blank PAYSTACK_SECRET_KEY/PAYSTACK_PUBLIC_KEY fields
and TEST-only instructions. Added exact Git ignore and a tracked blank local-docker.example template.
Documented that the Docker runner does not load this file or contact Paystack. Verified check-ignore
and whitespace; no application code changed. No credentials generated/copied, provider calls, live
operations or deployment. Test credentials remain needed for real-provider acceptance; full financial
engine implementation remains IN_PROGRESS with existing complete-plan approval.


## ACT-20261022-004 — durable withdrawal dispatch, recovery, cancellation and callbacks

Withdrawal dispatch claims ownership under the same locked reference before provider I/O. Only the
claim winner may initiate. A timeout/lost acknowledgement/crash leaves the intent started and funds
reserved; new service instances do not replay. Owner-scoped recovery uses GET verify by original
reference only. Provider not-found is uncertainty, not absence proof or permission to refund/restart.
Current owner and reserved recipient verification are checked again before dispatch. Invalidated
recipients cannot send; an undispatched reservation can still be cancelled safely.

Cancellation is owner-bound and atomic with wallet/request/receipt, only before dispatch ownership.
Duplicate cancellation refunds once. Concurrent cancellation/dispatch cannot both refund and send.
Started requests cannot use cancellation as a refund shortcut; operator/provider recovery is needed.
Provider transfer adapter now rejects invalid inputs, uses NGN integer minor units, rejects redirects,
bounds requests to ten seconds, validates acknowledgement envelopes/reference and never retries writes.
Recovery is a separate read. Pending/OTP/queued results are not completion receipts. An early callback
completion cannot be overwritten by a later pending initialization acknowledgement.

WithdrawalLedgerService/WithdrawalDispatchService are registered/exported in WithdrawalsModule;
WebhooksModule imports that authority. Signed transfer callbacks now route version-2 reservations to
atomic completion. Event type/status must agree; amount/reference/currency/domain/recipient/transfer
code must bind. Separate per-event-type provider acknowledgements follow the money receipt. Failed
acknowledgement after commit is retryable without another wallet effect. Historical/unversioned or
contradictory outcomes require reconciliation, not automatic adoption. Optional missing authority
fails unavailable for isolated legacy callers. Withdrawal creation API/UI remain disabled pending
owner endpoints, operator recovery and complete financial acceptance; no live transfer was initiated.

Docker runner resolves exact cached official repository/tag to immutable image IDs, addressing
Desktop's inconsistent tag inspection without repeated registry pulls. Final test containers/anonymous
volumes removed; existing Docker/local PostgreSQL resources untouched. local-docker secret field
checked without printing values: EMPTY. No actual provider credentials or network acceptance used.

Final verification: 255 general backend tests PASS, 32 opt-in skipped by default; all 32 real PG cases
PASS separately in Docker (287 distinct backend cases). Seven provider-adapter and five callback
integration cases added; eight PG dispatch/recovery/cancel/callback/recipient cases added to prior 24.
Billing Nest build, targeted lint/syntax/whitespace PASS. One earlier full run hit the known cold HTTP
fixture five-second timeout; isolated sequential rerun passed without weakening assertions/timeouts.
Legacy unavailable-message expectation retained; final suite passes. No frontend changes; prior 67
frontend cases/build/browser evidence remains earlier evidence, not rerun claims.

Remaining: owner withdrawal endpoint/DTO/recovery/UI integration, operator ambiguous-dispatch/history
reconciliation, funded attributed settlement/clearance and subscriptions; real provider/storage/cookie,
process-crash and deployed-schema acceptance. Complete engine still required, all phases approved,
no stage approval needed. No live funds/accounts/provider operations, migration, merge/push/deployment.


## ACT-20261022-006 — verified callbacks plus primary webhooks; owner withdrawal endpoints

JED clarified the confirmation contract: webhooks are primary; a browser callback may also complete
payment after server-side Paystack Verify API confirmation. URL reference is lookup input, never
payment proof by itself. Existing funding verifyFunding already performs that lookup and uses the
same atomic completeSuccessfulFunding authority as signed charge callbacks. Added real PostgreSQL
callback-first, webhook-first and simultaneous-flow tests, with repeat callback/webhook delivery:
one wallet credit/version and one unique completed receipt in every order. After webhook completion,
callback reuses the authoritative receipt without another provider call. Verification fixture provider
responses are synthetic; this does not claim actual hosted checkout/webhook delivery acceptance.

The configured TEST secret was accepted by Paystack's official read-only GET /balance API. New
scripts/plan0009-paystack-preflight.cjs explicitly reads backend/local-docker, refuses live/empty or
duplicate keys and redirects, bounds the request, and prints no secret/balance/raw response. Public
key TEST format checked only; pair ownership not independently proven. No transfer/payment created.
Official reference: https://paystack.com/docs/transfers/managing-transfers/ . Private file remains ignored.

Owner withdrawal API now delegates to the tested ledger/dispatch authority:
- POST /api/v1/withdrawals requires UUID-v4 requestId, UUID bankAccountId and a bounded amountUsd with
  at most two decimal places. Identity comes from req.user.sub, never body identity. A duplicate
  request recovers existing state without another dispatch or FX/provider initialization.
- GET /api/v1/withdrawals/:reference/status verifies original reference through provider read only;
  POST .../:reference/dispatch explicitly claims an undispatched reservation at most once;
  POST .../:reference/cancel can refund only before dispatch ownership. Each uses authenticated owner.
- Only an existing validated persisted fresh FX quote is used; no network/FX refresh in money
  transactions or duplicate withdrawal requests. Unavailable quote blocks new reservation honestly.
- Missing ledger/dispatch authority remains explicitly unavailable for legacy isolated callers.
  Existing history reads retained. Frontend payout UI is still disabled pending durable UI integration.

Final verification: 264 general backend tests PASS/35 opt-in skipped; all 35 real PostgreSQL cases
PASS separately in Docker (299 distinct backend cases). Billing Nest build, targeted lint, JS syntax
and whitespace pass. New tests include nine owner API/orchestration cases and three callback/webhook
PG interleavings. Test containers/anonymous volumes removed. Frontend unchanged; prior 67 frontend
cases/build/browser evidence remains earlier, not rerun. No live keys used, transfers, payments,
account changes, existing database migration, merge/push or deployment.

Plan remains IN_PROGRESS/all phases approved/full financial engine required. Remaining durable payout
UI, operator ambiguity/history reconciliation, funded settlement/clearance, subscriptions and real
hosted provider/webhook/storage/cookie/crash/deployed-schema acceptance remain open. webhook.site
capture alone is not application webhook delivery; an authorized public Billing callback/tunnel is
needed for that external acceptance. Continue independent implementation without renewed phase approval.


## ACT-20261022-007 — prominent continuation policy and durable withdrawal request recovery

JED again requires whole approved plans to run to completion without repeated proceed prompts.
Placed this rule at the TOP of the plan registry; routine checks/summaries must use commentary,
not become stopping points. Existing full-engine scope/approval and conditional merge/push retained.

Continued independent implementation: GET /api/v1/withdrawals/requests/:requestId derives the reference
from authenticated owner plus original UUID-v4 request identity, then recovers the existing attempt.
A browser that lost the creation response need not invent a reference or submit another withdrawal.
Recovery never reserves/dispatches. Shared derivation validates identities, normalizes request case,
and isolates owners. Added workflow and actual reference-identity property tests.

Verification: 266 general backend cases PASS/35 opt-in skipped; Billing Nest build, targeted lint and
whitespace PASS. Earlier 35 Docker cases remain previous evidence, not rerun. No frontend changes,
external provider calls, money movements, schema migration, merge/push or deployment in this slice.

Material financial input requested: plans mention fees but do not specify who bears Paystack transfer
fees. User deduction versus platform payment changes reserve/quote/net payout/accounting. Do not silently
choose a fee policy or advertise a full payout until resolved. This is a business decision, not stage
approval. Continue independent work while it is pending. Full financial engine/remaining acceptance
still required; PLAN-0009 IN_PROGRESS, no renewed phase approval required.


## ACT-20261022-008 — User-funded payout fees (2026-10-22)

JED decided: deduct Paystack withdrawal charges from the user's payout and display the net amount
before confirmation. This supersedes the unresolved fee-bearer question. Gross USD wallet debit,
FX rate, gross NGN, transfer charge, applicable stamp duty and net NGN must be separately visible.

Implemented locally: integer-kobo standard Nigerian non-payroll fee policy; durable five-minute
server quote; authenticated quote endpoint and required quoteId on public confirmation. Quotes bind
owner, request UUID, bank recipient, amount, FX snapshot, provider mode and fee-policy version.
Quote generation reserves no money. Confirmation reserves the gross USD amount and sends only the
quoted net NGN; concurrent duplicate confirmations reserve once. Discontinuous fee boundaries reject
amounts without an exact net solution rather than retaining an unexplained difference.

Quotes use billing_provider_events with provider=paystack and reserved reference/event namespace
internal.withdrawal.quote. This is an internal quote, not evidence of a provider event or payment.
The signed webhook dispatcher cannot write this namespace. No database enum/schema change required.
Published policy sources: https://support.paystack.com/en/articles/2130370 and
https://support.paystack.com/en/articles/7573314 (reviewed 2026-10-22). Actual merchant pricing and
actual incurred/refunded provider charges still require reconciliation. Failed/reversed quoted
payouts remain held for reconciliation; never refund a non-refundable levy speculatively.

Evidence: fee and API workflow suites 33 PASS; Billing build and targeted lint PASS. Docker PostgreSQL
quote race, wrong/expired quote and immutable-recipient tests added. No frontend activation, provider
transfer, production migration, merge or push. Remaining work includes quote/recovery UI, fee-aware
failure/reversal reconciliation, settlement, subscriptions and deployment acceptance. PLAN-0009
remains IN_PROGRESS; all phases already approved and no new routine permission is required.

## ACT-20261022-010 — Withdrawal confirmation checkpoint (2026-10-22 09:22 UTC)

PLAN-0009 remains IN_PROGRESS. User requested frontend/backend checkpoint commits followed by
continued execution. Includes previously accumulated PLAN-0009 work; these are local checkpoint
commits, not plan completion, release merges, push or deployment.

New frontend: review gross USD debit, FX, gross NGN, transfer fee, stamp duty and net NGN before
confirmation. Quote edits invalidate review. Durable URL request UUID precedes the first payout POST;
unknown outcomes/reloads expose GET recovery without repeating a transfer. Server status drives results;
wallet refresh reads real API data. Immutable quote and recovery helper tests cover expiry, fee totals,
foreign details, malformed statuses and no automatic replay.

Verification: 73 frontend tests PASS; Billing production build and post-build types PASS; targeted lint
PASS (existing config warnings). Browser synthetic-only checks: light/dark quote, 343px container,
pending submission and reload preserving request UUID. Temporary fixture removed before final build.
Backend general suite: 288 PASS, 39 opt-in skipped; separate earlier Docker PostgreSQL run 39 PASS.
Billing backend build and diff whitespace checks PASS. local-docker remains ignored; no real transfer.

Still open: explicit undispatched cancel/dispatch UI, fee-aware failure/reversal reconciliation,
provider acceptance, funded settlement, subscription engine and remaining full-plan acceptance gates.

## ACT-20261022-011 — Continued refund recovery (2026-10-22 09:30 UTC)

Checkpoint commits created on dev: frontend fd99f8f, backend 3313be3. No push/production merge.
Continued immediately: unsent reservation cancellation UI and exact-reference cancellation response
validation; new API test. JED's subsequent decision: deduct confirmed non-refundable charges from
failed/reversed withdrawal refunds. Quote UI discloses this and original-rate nearest-cent rounding.

Backend now supports atomic fee-deducted refunds only when a separately reviewed internal evidence
receipt matches reference, quote, mode, currency, outcome and transfer code. Costs must be nonnegative
integer kobo within the quoted fee/levy limits; two different reviewer identities are required. Missing
proof retains the reserve. Original FX converts retained costs; receipt records refund and retained
amounts. Concurrent failure/reversal completions refund once. This is the ledger consumer, NOT a
completed operator evidence-ingestion/approval workflow; no public endpoint can submit that receipt.

Evidence: 32 fee/refund math tests PASS; 41 separate real Docker PostgreSQL tests PASS using synthetic
reviewed evidence. No actual transfer/refund, production data changes or provider-fee acceptance.
Provider sources: https://paystack.com/docs/api/transfer/ ;
https://paystack.com/docs/api/transfer-control/ ; https://support.paystack.com/en/articles/7573314 .
Provider samples do not establish levy refund semantics: fee_charged alone is not a reconciled net cost.
Remaining: operator evidence workflow, full UI verification for this addition, settlement, subscriptions,
and all remaining acceptance gates. Execution continues; PLAN-0009 remains IN_PROGRESS.

## ACT-20261022-017 — Handoff security audit

Read .agents/HANDOFF.md and preserved the newer agent changes. Closed the legacy refund-evidence
endpoint before service access: authenticated owners could supply both purported operator identities,
which did not establish authorization or independent approval. Added a forged-role/body regression.
Targeted withdrawal API suite: 12 PASS. Billing Nest build: PASS. The operator workflow remains
unfinished; actual grants, server-derived identities and independent review are required before release.
Prior checkpoint commits remain frontend fd99f8f/backend 3313be3. No push or production merge.

## ACT-20261022-018 — Independent refund review workflow

Continued PLAN-0009 after handoff audit. Added RefundReviewService with server-only explicit UUID
operator grants (BILLING_REFUND_OPERATOR_IDS, empty denies all), current ACTIVE-account checks,
self-withdrawal prohibition, immutable pending evidence drafts and separate authenticated approval.
Preparation/review identities come from verified subjects, never body-supplied names. Approval checks
both actors and fresh provider transfer verification; repeated concurrent approval is idempotent.
The ledger accepts version-2 independent-review receipts only; old single-call version-1 evidence is
quarantined rather than adopted. Human operators must actually inspect referenced provider balance
records: transfer verification alone does not prove retained charges. Approved receipts are consumed
by callback retry/owner recovery through the existing atomic refund ledger.

Verification so far: 19 focused API/authorization tests PASS; Billing build and targeted lint PASS
before final provenance refinement; full suite and final build pending. Added a real-PG scenario for
unauthorized access, self-review, incorrect draft, suspended preparer and concurrent approval, but
Docker engine is unavailable (named pipe absent). Launch attempted; user asked to start Desktop and
resolve any startup prompt. This is missing environment access, not a phase approval. Independent
work continues. No real provider transfer, production migration, merge or push.


## ACT-20261022-019 — Continuous implementation and verification

Refund review checkpoint: full backend suite 332 PASS, 42 opt-in PG cases skipped (Docker engine unavailable). Frontend 75 PASS from preceding run; final Billing production build and post-build tsc PASS; temporary fixture removed. Actual refund component in synthetic 375px iframe: viewport/document both 375, light/dark and keyboard focus inspected. No provider calls in fixture. Ads attribution prerequisite removes default signing secret, validates versioned token structure/TTL/IP and persisted serve binding, and rejects fabricated mobile attestation/reward success. Initial 20 token tests and Ads build PASS; expanded checks pending. Plan remains IN_PROGRESS; settlement/subscriptions and real provider/environment acceptance remain open.


## ACT-20261022-020 — Subscription engine and approved ad price units

- JED confirmed standard CPM per 1,000 eligible impressions and CPC per eligible click. New campaign/serve pricingVersion=2; historical rows stay version 1. Migration 0015 is registered after journal entry 0013; existing standalone/unregistered 0014 is not silently adopted. Migration has NOT run against existing databases. Auction ranks normalized eCPM but records immutable per-event nano-USD prices; exact carry avoids per-impression cent rounding. Six pricing tests pass.
- Subscription initial checkout: request UUID persisted before one provider initialize; common atomic completion for signed webhook and server Verify callback; exact amount/currency/mode/email/owner/intent binding. Paid entitlement has a bounded UTC calendar period and verified receipt. Callback routing separates subscription payments from wallet funding.
- Recurring engine: explicit authenticated consent, owned saved authorization, fixed USD price and maximum NGN debit; durable generation/reference before one charge call, no resend after uncertainty, period-end cancellation, recovery after cancellation preserves paid access but keeps future renewal disabled. Bounded worker scans use cursors to avoid starvation and require BILLING_SUBSCRIPTION_RENEWALS_ENABLED=true (not enabled locally).
- Dashboard: one-period checkout/recovery integrated; recurring-consent UI still pending. Synthetic actual-component browser proof: one POST total across checkout/status confirmation, 375px viewport/document, light/dark and keyboard focus inspected. Fixture removed.
- Verification: 370 general backend PASS; 48 separate real PostgreSQL cases PASS (new disposable SCRAM PostgreSQL 17 fallback, provider doubles only), all temporary cluster files removed. Frontend 80 PASS. Final Billing frontend production build/post-build tsc PASS. Ads/Billing Nest builds PASS; targeted backend lint PASS. Latest pricing/token focused suites 29 PASS. Full suite predates the six new pricing cases; no inflated combined final-run claim.
- Remaining: funded settlement/clearance and historical reconciliation; renewal settings UI and expanded release/worker/provider acceptance; session/OAuth/a11y/DTO/deployed configuration checks; final merges and push. No actual provider payments/charges/transfers, production migration, merge, push or deployment.

## ACT-20261022-021 — Funded settlement and independent clearance

PLAN-0009 remains IN_PROGRESS. Implemented versioned persisted-event claims, fractional CPM carry, Billing-owned escrow consumption and 72-hour pending publisher receipts. Clearance requires two distinct active explicitly granted operators, excludes beneficiaries, rechecks claimed activity and credits the publisher atomically once. Authenticated read/prepare/approve review routes are registered; settlement dispatch integration and rejection/rebate workflows remain unfinished. Fixed PostgreSQL microsecond boundary comparison and isolated settlement-batch fixtures.

Verification: 53/53 isolated PostgreSQL tests PASS (temporary SCRAM cluster removed), 2/2 clearance API identity/DTO tests PASS, latest Billing Nest build PASS. Provider calls in database tests are doubles; no real Paystack acceptance, existing database migration, production merge or push. Continue implementation and remaining release verification without checkpoint approval.

## ACT-20261022-022 — Staff settlement transport verified

Funded per-campaign settlement is now connected: Ads finance staff POST /ads/billing/settlements/funded sends campaignId, durable requestId and closed ISO periodEnd once to Billing's authenticated internal /ecosystem/campaigns/:campaignId/settlements boundary. A lost response retains the original UUID/period for idempotent recovery. Legacy global settlement/automatic cron remains quarantined. UUIDs are canonicalized before financial locks/receipts; clearance holds shared locks on examined interaction rows.

Evidence: 381 general backend tests PASS (53 PG opt-in cases skipped there and separately 53/53 PASS against disposable PostgreSQL); both latest Ads/Billing Nest builds PASS; targeted Ads billing and Billing ecosystem ESLint PASS. Initial sandbox HTTP run failed on loopback EACCES; authorized rerun passed. No real provider acceptance or production merge/push. Rejection/rebate, recurring preferences UI, migration/staging and other release gates remain open.

## ACT-20261023-001 — Requested dev / production synchronization

JED explicitly requested committing current work to dev, merging to production and pushing origin after updating RAILWAY_API_TOKEN. This request supersedes the earlier conditional release timing; PLAN-0009 remains IN_PROGRESS. Verified 381 general backend tests PASS, 53 isolated PostgreSQL tests PASS (temporary cluster removed), 80 frontend tests PASS, Ads/Billing backend and frontend production builds PASS, Billing post-build types PASS and changed backend TypeScript lint PASS. Initial sandbox loopback/PostgreSQL failures were resolved by authorized execution outside sandbox; directory-wide lint included generated JS, then changed-source TypeScript lint passed.

Next PLAN-0009: complete funded-claim rejection/rebate workflow; verify the present recurring-preferences UI; historical financial reconciliation and deployed schema/migrations 0015/0016 review; provider/worker/callback, real session/cookie/OAuth and accessibility/DTO acceptance. No production database migration or provider money operation performed. Railway deployment outcome is not established by Git synchronization.

## ACT-20261023-003 — Production deployment repair

Fixes: pnpm workspace frontend build context and dependency-first typecheck; compiled database package exports plus stale generated-source removal and runtime smoke gate; Ads DATABASE_URL support and private-network DB_SSL handling; truthful Ads/Billing readiness; bounded migration diagnostics and Auth read-only preflight separated from startup. Railway configuration staged with secure references to Auth JWT_ACCESS_SECRET and repository-root frontend builds. Verification so far: frontend workspace typecheck, three affected frontend builds and 80 tests PASS; backend 381 tests PASS before final database-module/readiness changes; focused final checks pending. No production migrations or real provider money operations. Detailed diagnosis in workspace docs/architecture/PLAN-0009-production-deployment-diagnosis.md. PLAN-0009 remains IN_PROGRESS.

## ACT-20261023-004 — File-based browser origin policy and guarded schema repair

JED requested removing ALLOWED_ORIGINS from every application's environment and maintaining editable allowlist files. Added shared/src/config/cors-origins.json plus editing instructions; all backend HTTP apps and Chat WebSocket CORS consume the shared file. Auth permits credentialed refresh from listed first-party origins; public Ads delivery/pixel/catalog/media remains wildcard and cookie-free, while private dashboard routes remain restricted. No delivery hostname change required. Removed origin env parsing/config examples; Railway variable removal and rollout pending.

Verification: all ten backend package builds PASS, compiled runtime smoke PASS, final 388 backend tests PASS /53 opt-in PG skipped. Separate full migration check upgrades an initial disposable schema, verifies every application column, safely replays and rejects corrupted history; temporary cluster removed. Explicit 0017 migration adopts the previously unregistered dispute schema without rewriting historical migration records. Controlled release runner verifies existing ledger hashes and holds an advisory lock before pending migrations. Production migration not yet executed; recovery archive created and validated through the explicitly approved temporary SSH key. PLAN-0009 remains IN_PROGRESS.

## ACT-20261023-011 — Real TEST transfer acceptance and two-run audit correction

- Paystack TEST transfer acceptance passed for wd_37ad650fa6e07fb2bc5e06bdb038b46b589caa8a: independent dispatch races sent once, quoted NGN 490 recipient binding, GET recovery and one wallet reserve consumption. Owner entered OTP in Paystack.
- Owner observed two transfers. Read-only provider listing confirmed two successful TEST requests: earlier wd_f754f0434007e849d92edb6acc0e7148eac0f169 at 16:57:37 UTC and replacement wd_37ad650fa6e07fb2bc5e06bdb038b46b589caa8a at 17:01:34 UTC. Earlier run had stopped awaiting OTP, but its provider request remained approvable. Both were approved; the first disposable ledger was already removed, so its recovery is unproven. Single-dispatch proof applies per request, not across reruns. No live money moved.
- Corrected harness to audit bounded TEST transfer history and refuse new payout creation while an earlier CrimFig request is unresolved. Lint/diff checks passed; no new payout initiated to recheck this guard.
- Final backend regression 397 passed / 67 opt-in skipped; separate real PG 63, Redis OAuth 2 and provider checkout/transfer 2 passed. Ten package builds and compiled runtime smoke passed. Plan remains IN_PROGRESS; staging DNS and real-session/provider-webhook acceptance remain open.

## ACT-20261027-016 â€” Chibi ninja avatar presets

Added PLAN-0037 avatar preset storage (`avatar_preset_id`, `avatar_version`, `avatar_updated_at`) and migration 0019. Extended Auth `/me`, added authenticated preset catalog and PATCH selection/reset routes with server-side preset validation and version increments. Fresh disposable DB migration and local additive migration PASS; Auth API endpoint checks PASS (default, 12 presets, select/reset, invalid 400); Auth build and 426-test backend suite PASS. Custom upload/re-encode remains unimplemented; no production migration or deployment.
