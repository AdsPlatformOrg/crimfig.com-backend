# CrimFig Database Schema Architecture & Naming Conventions

This document defines the strict table naming conventions and anti-collision rules for the CrimFig Ecosystem shared PostgreSQL database (`crimfig_core`).

---

## 1. Core Ecosystem Rule: Namespaced vs. Shared Tables

The CrimFig platform operates as a unified multi-service ecosystem sharing a high-availability PostgreSQL cluster (`crimfig_core`).

To ensure total isolation between app domains while allowing seamless cross-app relationships (via foreign keys):

### A. Shared / Core Infrastructure Tables (Common Names)
Tables representing platform-wide entities shared across all applications MUST use clear, un-prefixed common names:

| Table Name | Scope | Description |
| :--- | :--- | :--- |
| `users` | Core Platform | Central user credentials, authentication state, MFA |
| `individual_profiles` | Core Platform | User public profiles (full name, avatar, bio, country) |
| `organizations` | Core Platform | Workspaces, business accounts, teams |
| `organization_members` | Core Platform | Multi-tenant organization memberships and roles |
| `apps` | Core Platform | Registered applications within CrimFig SSO/OIDC ecosystem |
| `user_app_consents` | Core Platform | User authorization grant records per ecosystem app |
| `mfa_devices` | Core Platform | Hardware/TOTP/FIDO2 MFA authentication factors |
| `oauth_clients` | Core Platform | Registered OAuth2 clients for third-party & internal apps |
| `refresh_tokens` | Core Platform | Rotatable JWT refresh tokens across services |
| `audit_logs` | Core Platform | Platform-wide security, auth, and data audit trail |

---

### B. App-Specific Tables (Explicit Prefix Convention)
Tables that belong to a specific microservice or feature app MUST be explicitly prefixed with that app's identifier:

#### 1. Billing Service (`billing_*`)
- `billing_wallets`: User USD cents ledger and reserved locked balances.
- `billing_exchange_rates`: Live and historical USD/NGN exchange rate audit snapshots.
- `billing_saved_cards`: PCI-DSS tokenized authorization codes for cards.
- `billing_transactions`: Append-only immutable financial transactions ledger.
- `billing_subscriptions`: Recurring subscription cycles across ecosystem apps.
- `billing_provider_events`: Webhook event idempotency tracking (Paystack / Stripe).
- `billing_bank_accounts`: Registered Nigerian bank accounts for payouts.
- `billing_withdrawal_requests`: Payout state machine tracking locked USD to bank transfer.

#### 2. Ads Platform (`ads_*`)
- `ads_campaigns`: Advertiser campaign definitions, budgets, and targeting.
- `ads_creatives`: Visual banners, cards, and copy assets for campaigns.
- `ads_promoters`: Registered promoter profiles (`WEBSITE`, `INDIVIDUAL`, `MOBILE_APP`).
- `ads_promoter_websites`: Domains registered by website publishers.
- `ads_promoter_apps`: Mobile apps registered by app publishers.
- `ads_placements`: Placement instances linking campaigns to promoter channels.
- `ads_interactions`: Append-only immutable interaction log (impressions, clicks, embed pings).
- `ads_promoter_earnings`: Accrued promoter revenue ledger per interaction.
- `ads_reels_consents`: Creator consent for auto-posting ad placements to CrimFig Reels.

#### 3. Future Ecosystem App Prefix Standard
Any new service integrated into `crimfig_core` must follow its designated prefix:
- **Chat App**: `chat_threads`, `chat_messages`, `chat_participants`, `chat_attachments`
- **Reels App**: `reels_posts`, `reels_comments`, `reels_likes`, `reels_hashtags`
- **Stream App**: `stream_channels`, `stream_broadcasts`, `stream_recordings`
- **Notifications**: `notifications`, `notification_preferences`

---

## 2. Duplicate Prevention Checklist for New Tables

Before adding any new table or running `drizzle-kit generate`:
1. Check `backend/database/schema/index.ts` to ensure the table name is not already taken.
2. Verify table name matches either the **Core Platform** un-prefixed list or has an explicit `<app_prefix>_*`.
3. Check PostgreSQL `pgEnum` names — Enums must also be namespaced (e.g. `ads_campaign_status`, `billing_transaction_type`).
4. Check index names — Drizzle index identifiers must be globally unique across the database (e.g. `billing_wallets_user_id_idx`).
