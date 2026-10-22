# Billing API: authenticated dashboard boundary

PLAN-0009 local implementation, 2026-10-21. Deployment and dashboard integration
remain gated; this change does not enable live payment processing.

## Required configuration

- `JWT_ACCESS_SECRET`: the same secret used by the Auth API to sign HS256 access
  tokens. No fallback exists; missing configuration prevents authentication module startup.
- `ALLOWED_ORIGINS`: optional comma-separated exact dashboard origins. Defaults are
  Ads, Billing and Auth HTTPS origins, plus explicit localhost development ports
  outside production. Wildcards, URL credentials/paths and production HTTP are rejected.
- `INTERNAL_ECOSYSTEM_KEY`: explicit shared service key for ecosystem wallet calls,
  configured on both the Billing server and authorized service clients. There is no
  built-in key or development bypass. Missing configuration denies these calls.
- `PAYSTACK_SECRET_KEY`: explicit provider key for funding and callback verification.
  No mock key or development signature bypass authenticates callbacks.

Configure secrets through the environment/secret manager, never browser snippets or
committed example values. Existing deployment-specific origins must be explicitly listed.

## Authentication and ownership

The global Billing guard verifies signature, expiry, access-token purpose and user ID,
then loads the current account and rejects suspended/deleted/missing users. Controllers
derive owner/email from that account rather than x-user-id/x-user-email headers.

Protected browser requests send a bearer token and omit cookies. Billing does not
enable credentialed public CORS. Account/session cookies stay with Auth refresh/logout.
Health/catalog and other explicitly Public routes remain distinct from dashboard auth;
Public service/provider endpoints must perform their own service-key/signature validation.

Funding-reference verification requires both reference and authenticated owner before
contacting the provider. Existing card/subscription/bank-account services retain their
owner filters. This is not a claim that all financial idempotency/settlement concerns have
been resolved by authentication changes.

Paystack handlers use Nest's captured rawBody (rawBody:true is configured in main.ts)
and verify its HMAC in every environment. Do not reserialize JSON before verification.
The Stripe route remains an acknowledgement-only placeholder; it performs no verified
Stripe processing or money mutation and must not be advertised as implemented.

## Refresh coordination dependency

Auth rotation now preserves family/app identity and atomically revokes/inserts inside a
READ COMMITTED transaction with a transaction-scoped family advisory lock. Logout uses
the same lock and revokes descendants. Recent reuse with a live successor returns 409
REFRESH_CONFLICT for 10 seconds without issuing tokens or changing cookies; later replay
revokes the family and returns 401 after the revocation commits.

The shared browser client treats 409 as a recoverable temporary state and never blindly
retries a consumed cookie. The future UI must offer explicit retry after the winning
refresh response has updated the shared cookie, or login when no usable cookie remains.
Only browser contexts actually sharing that cookie participate; check Domain, Path,
SameSite, HTTPS and CORS in staging. Same-origin Web Locks alone do not span subdomains.

Existing historical families created by the old rotation implementation cannot be
reconstructed retroactively. Decide the rollout reauthentication/session-retirement policy
before release; no historical tokens or production sessions were revoked by this work.

## Verification

From backend, using the installed local tooling:

```powershell
node node_modules/jest/bin/jest.js --config auth/jest.config.js --runInBand
node node_modules/typescript/bin/tsc -p shared/tsconfig.json
```

The Auth test harness also runs Billing security fixtures under auth/test/security.
Fixtures use local HTTP, fake accounts and mocked provider/database services. They never
contact production. Rotation tests use a transactional adapter and compiled Drizzle
predicates; PostgreSQL multi-process integration and real browser cookie/CORS verification
remain staging gates. Use the separate service's Nest build script for production bundling.

Do not deploy the guard independently of configured keys and coordinated frontend login
wiring: the old demo-header-only dashboard calls are intentionally rejected.

Transaction design references: [PostgreSQL transaction-scoped advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) and [Drizzle transaction/rollback semantics](https://orm.drizzle.team/docs/transactions).


## PLAN-0009 campaign escrow authority (ACT-20261021-016)

Billing now atomically owns campaign reservations/releases, owner status transitions, wallet changes
and durable receipt insertion through CampaignEscrowService. Ads and Billing must share the same
PostgreSQL schema; coordinate both API deployments. See api/ads-api/src/modules/billing/README.md
for route contracts, cumulative allocation semantics, current-lifecycle replay scope and rollout gates.
The legacy generic internal lock/unlock/deduct-spend/credit-earning endpoints return 503 after internal
key validation. They must not be re-enabled for backward compatibility. No settlement earnings are
issued until correct attribution/funded clearance are implemented; legacy items require reconciliation.
Existing funding completion, withdrawal methods/provider callbacks and subscription workflows are
NOT made transaction-safe by this new campaign-specific boundary and remain separate execution gates.
Read-only reconciliation SQL was prepared at workspace docs/architecture/PLAN-0009-financial-reconciliation.sql
but never run. No database migration or live financial transaction was executed.


## Funding completion checkpoint (ACT-20261021-018)

The previous funding-completion warning is narrowed by the new version-2 backend contract:
checkout intent/reference is persisted first, owner verification and signed callbacks converge on
one atomic wallet/receipt transaction, and proof reference/amount/currency/mode/owner binding is
validated. See workspace docs/architecture/PLAN-0009-funding-completion-contract.md for details.
Configure BILLING_WEB_URL to the Billing root; production funding requires a live Paystack key.
No live readiness is implied: real PostgreSQL/provider tests, return/reconciliation UI, initialization
request identity, FX and historical reconciliation remain gates. Saved-card charging, subscription
charge completion, withdrawals and funded Ads settlement are not enabled by this checkpoint.
Full backend regression suite: 178 passing; Billing build and targeted lint pass. Mocks/loopback only.


### ACT-20261021-020: durable funding initialization

Funding POST now requires UUID v4 requestId. Owner-scoped deterministic reference/locked intent claim
allows one provider initialize; repeated calls recover the original quote/result, with immutable payment
binding. GET /api/v1/wallet/funding-requests/:requestId recovers without provider/FX calls. The console
retains funding_request before POST, performs read-only recovery after reload and resumes only on
explicit action. Ambiguous/crashed started requests never automatically reinitialize or expire. Early
completion metadata survives checkout persistence; completed attempts never redirect to checkout.
See PLAN-0009-funding-completion-contract.md for endpoint payloads, coordinated release requirements
and remaining real PostgreSQL/provider/crash-reconciliation/FX gates. No schema migration or live money.


### ACT-20261021-022: freshness, unavailable payment boundaries and acceptance evidence

See docs/architecture/PLAN-0009-acceptance-checkpoint.md (workspace-root path) for current evidence.
FX requires validated, persisted, correctly sourced provider proof; no hardcoded/stale emergency quote
or default key. Same rate snapshot used for conversion; both provider/retrieval ages <24h, no future data.
FX routes authenticated; manual refresh unavailable; bounded history excludes raw data; conversion strict.
Withdrawal creation/subscription charging stop at service entry, and signed transfer callbacks return
unavailable without legacy mutations/processed acknowledgement. These are quarantines, not completed
payment state machines. History stays available. Funding completion retains its original stored quote.
204 mocked/loopback backend tests and 7 separate actual PostgreSQL funding cases pass; existing database
untouched. 62 frontend tests, final Ads/Billing builds/post-build types/lint and local UI checks pass.
Fonts/theme/capability-copy/alerts/moderation wrapping corrected; remaining staging, financial and a11y
checks tracked explicitly. Every phase approved; PLAN-0009 remains IN_PROGRESS; conditional merges/push
not executed. Auth build attachment still deferred. No live funds/provider account/migration/deployment.
