# Ads dashboard security rollout

Ads installs a default-deny global bearer guard. Configure `JWT_ACCESS_SECRET` to match
Auth's access-token signer. Only access JWTs with valid signatures, expiry and user identity
are accepted. Every protected request loads the current account; missing, suspended and
deleted accounts are rejected. Identity headers and demo-user fallbacks have been removed.

## Staff permissions

`ADS_STAFF_ROLE_GRANTS` is a server-managed JSON object mapping existing account UUIDs
to role arrays. The default `{}` grants nobody staff access. Invalid JSON, account IDs or
unknown roles fail startup. This is a transitional deployment-owned authority because the
current schema has no platform staff assignment table. Store it in restricted server
configuration; changes require a restart/redeploy. No role is taken from a JWT, request
header, request body or organization membership. No user/grant was seeded by this change.

| Action | Explicit grant required |
| --- | --- |
| Moderation queue | ads_reviewer, ads_manager, ads_admin, ads_support or super_admin |
| Creative decisions and primary campaign review, including legacy decision route | ads_reviewer |
| Manager sign-off | ads_manager |
| Audited emergency override | super_admin |
| Promoter suspension | ads_admin or super_admin |
| Settlement/audit/rebate/penalty administration and dispute resolution | ads_finance, ads_admin or super_admin |

Grant a role only after independently verifying the account UUID. Super Admin does not
implicitly satisfy reviewer or manager checks; emergency override has its own reason/audit
workflow. Campaign/creative owners cannot perform normal self-review; existing separation
between primary reviewer and manager remains enforced. A future persistent role service
must preserve these endpoint checks and add auditable grant/revoke administration.

## Owner and public boundaries

- Ordinary billing overview, escrow and campaign APIs use the verified account. Campaign
  details, escrow reads/locks and disputes now enforce owner predicates before sensitive
  reads or Billing operations. Placement creation verifies the promoter, owned site/app and
  approved creative belonging to the selected approved active campaign.
- Advertisers can request active/paused/trash status, with moderation approval required for
  activation. Suspended campaigns require staff handling. Failed activation funding prevents
  activation. Pause/trash stops serving before release; a release error is surfaced and needs
  reconciliation. This is not a distributed transaction or idempotent escrow implementation.
- Public delivery/catalog/health retain explicit public metadata. Conversion script and pixel
  collector are public. S2S POST `/api/v1/conversions` retains its own advertiser API-key
  authentication, requires conversions:write and an available key owner; conversion lists,
  reversals and key administration require dashboard bearer authentication.
- Pixel events are untrusted telemetry: no payable attribution and no authoritative order ID
  reservation. S2S click attribution additionally checks campaign advertiser ownership. Existing
  historical pixel rows are not rewritten: audit prior attribution/dedupe records before rollout.
- `/api/v1/uploads/media/:storageKey` serves only ready assets bound to approved active
  creatives/campaigns owned by the asset owner. Unreviewed files return 404. The authenticated
  `/api/v1/uploads/private-media/:storageKey` route allows owner preview of ready assets.
  Frontend previews must fetch this route with bearer auth and use a blob URL; an img element
  cannot add the Authorization header. No preview UI is wired in this slice. Responses use
  no-store to avoid stale public approval or cached private media after permission changes.
- Public media matching uses the persisted canonical CDN URL; historical creative URLs must
  match that canonical value. Other media bindings need explicit migration/normalization.
- Removed duplicated controller prefixes: Ads billing, conversions and disputes now resolve
  under the application's single `/api/v1` prefix.
- Public delivery/pixel/catalog/media browser routes use wildcard CORS without cookies.
  Dashboard/admin/private-media routes use exact origins from `shared/src/config/cors-origins.json`
  through the shared validator, without credentials or identity headers. CORS does not replace route authentication.

## Verification and unfinished gates

Local HTTP fixtures exercise the production guard, role metadata and actual controller routes
with fake accounts and mocked services. Query tests compile Drizzle ownership predicates but
are not PostgreSQL integration tests. No database, Firebase, payment provider or production
service is contacted. Ads build/typecheck/lint and security tests pass.

Coordinate frontend shared-session providers, login/MFA return and authenticated media
previews before rollout. Browser cross-subdomain cookies/CORS, real database concurrency and
full application visual checks remain pending. Existing public mobile attestation/reward
placeholders are not validated secure mobile monetization. PLAN-0010 owns delivery evidence;
PLAN-0008 remains queued. Duplicate-credit, partial-failure and idempotent settlement gates in
`src/modules/billing/README.md` remain unresolved; this change does not enable live payouts.
