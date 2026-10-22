# Ads to Billing financial boundary

PLAN-0009 checkpoint, ACT-20261021-016. This supersedes the earlier transport-only notes.

## Configuration and ownership

`INTERNAL_ECOSYSTEM_KEY` must match Billing. There is no fallback secret. `BILLING_API_URL`
accepts a service root or `/api/v1`; the local default is `http://127.0.0.1:3008/api/v1`.
Requests reject redirects, time out after 10 seconds and never automatically replay writes.
Balances retain Billing's nested USD/NGN shape, actual zeros and owner/total validation.
No service/provider bodies or secrets appear in client errors.

Ads and Billing must use the SAME authoritative PostgreSQL database/schema for this contract.
Billing now owns campaign escrow, wallet and owner campaign-status writes in one transaction.
Ads checks owner scope before calling Billing and keeps read-only escrow/overview projections.
Billing repeats ownership/moderation checks under its campaign row lock. A separate-database
installation is unsupported: stop and design a durable outbox/saga rather than reintroducing
Ads wallet writes or pretending a remote call participates in a local transaction.

## Internal endpoints (not publisher/browser APIs)

All paths start `/api/v1/ecosystem/wallets/:userId/campaign-escrows/:campaignId/` and
require the configured internal key, including in development. They must not be exposed as
publisher installation credentials. Dashboard users continue through authenticated Ads APIs.

- `POST reserve`: `{ amountUsdCents, reason }`, amount 500..2147483647 integer cents.
- `POST release`: no caller-controlled amount; derive unconsumed balance from locked escrow.
- `POST status`: `{ status: active | paused | trash }`; reserve/release and campaign status commit
  together. Activation requires current approved moderation and valid remaining budget. Manual
  release rejects active campaigns; use the status transition to stop serving atomically.
- Result: `{ status: success, data: { escrow, operationId, transactionId, replayed, campaign? } }`.
  An unfunded draft pause/trash has `escrow/operationId/transactionId: null` and no money receipt.

Billing uses READ COMMITTED with a campaign advisory lock, campaign/escrow row locks and wallet
row lock. This serializes absent-row escrow creation and reservations across campaigns using
the same wallet. Transaction-local lock/statement timeouts bound waits. Wallet, cumulative
allocation/refund counters, wallet version and immutable Billing transaction receipt either all
commit or all roll back. Available/locked underflow and int4 overflow reject; no GREATEST clamp
creates or unlocks money. Billing performs no provider/network/FX work in this transaction.

Receipt IDs are `ads-escrow:v2:<escrowId>:reserve|release:<cumulativeAllocatedCents>`, enforced
by the existing unique `billing_transactions.idempotency_key`. Same-generation repeats return
the committed receipt instead of moving funds again. Active reservation resizing returns conflict.
After release, a new reserve increases cumulative allocation while preserving consumed/refunded
history; it creates a new generation and receipt. These are reservation transfers, not ad spend
or publisher earnings. They use internal_debit/internal_credit plus versioned campaign metadata.

Idempotency is scoped to the current reservation lifecycle, not an arbitrary replay across a
later pause/reactivation cycle. There is still NO automatic write retry. After an ambiguous HTTP
failure, reload campaign/escrow and reconcile the receipt before issuing a fresh user action.
A future retry/outbox implementation must carry an explicit expected generation/request identity
through the entire request, rather than deriving intent again after state has advanced.

## Quarantined legacy money paths

The old generic internal `lock/unlock/deduct-spend/credit-earning` routes authenticate and then
return 503. No current Ads client uses them. Coordinated Ads/Billing release is required.
Withdrawals' older WalletService methods are separate legacy paths, NOT covered by this change;
withdrawal/provider state machines and funding completion still require their own hardening.

Settlement creation, 72-hour clearance and financial deep/extended audit mutations return 503
before database/network work. Their unsafe demo bodies were removed, not put behind a feature
flag that can accidentally restore them. Financial cron jobs do not run those paths. Historical
settlement/audit/rebate/penalty reads remain available to authorized finance/admin staff.
The diagnostic embed/rollup cron continues, explicitly without settlement. Public embed pings
no longer auto-verify either websites or apps; they are not ownership or payable evidence.
Mobile manual verification remains a separate known placeholder, not production attestation.

Removed behavior included paying the first promoter instead of the event's actual beneficiary,
charging overlapping/open-ended event windows at fixed example prices, initial wallet credit
followed by a second clearance credit, rebates to the first campaign, and simulated penalties.
Do not infer that removing these paths completes funded settlement.

Moderation manager approval and super-admin override now leave approved campaigns PAUSED and
return `live: false`. The advertiser must activate through Billing's atomic funding transition.
The manager button says `Approve Campaign`, with existing styling/layout retained.

## Reconciliation and rollout gates

Existing unreceipted/duplicate/invalid escrow records return conflict; there is no automatic
legacy adoption, new credit, reversal or data rewrite. See the prepared read-only queries in
`docs/architecture/PLAN-0009-financial-reconciliation.sql` at the workspace root. They were NOT
executed. Even historical items lacking Billing transaction IDs may already have been paid;
absence of a receipt is not proof that another payment is due. Review historical attribution,
wallet movements, shared monetization entries, cleared/uncleared items, rebates and penalties.
Any repair needs a separate reviewed, auditable repair procedure and stable operation identity.

Before deployment, verify shared DB topology/schema/permissions and existing uniqueness,
execute real PostgreSQL multi-connection rollback/lock/timeout tests, and coordinate both APIs.
Do not deploy only one side or re-enable old generic write routes as a compatibility shortcut.
Actual funding/subscription/withdrawal completion, durable attributable event claims, accurate
campaign pricing, half-open event windows/deduplication, beneficiary splits/rounding, funded
pending-vs-available balances and atomic penalty/rebate recovery remain execution gates.
PLAN-0010 owns public delivery/validated evidence. PLAN-0008 owns funded rewards. No raw browser
interaction or house/test event may create payable/rewardable value.

The tests use a transactional in-memory adapter and a local real HTTP Ads-client/Billing-controller
fixture. They exercise rollback/failure, receipt replay, cycles, ownership, balance limits,
status serialization and unavailable legacy paths. They do NOT prove PostgreSQL's lock manager
or real staging/provider behavior. No live money or historical data was changed.
