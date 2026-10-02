# Platform Business — کسب‌وکار پلتفرم

## Architecture

The platform company is one ordinary RLS-protected business with
`businesses.ownership_kind = 'platform_internal'`. A partial unique index makes that marker a
singleton; the mutable name and subdomain are never used as identity. Its trade profile is
`service_saas`, while ownership remains an independent lifecycle field.

There are still exactly four app keys (`accounting`, `crm`, `growth`, `website`). My Workspace
continues to extend `ai_projects`; it is an entitlement/work area, not a fifth app.

`POST /api/platform/company/setup` is the explicit, idempotent central-cloud initializer. It
creates the chart only on the first provision, grants the four app entitlements plus Workspace,
and maps the initializing platform identity to a real tenant membership. It never reruns opening
balances. Ordinary customer list/count, subscription renewal, reset, archive and delete paths
exclude or refuse the protected business. Whole-system backup continues to include it.

## Authorization and switching

`withPlatformCompany()` is the central adapter. It rechecks the active platform identity and
active company-member mapping, applies the business preset, and then replaces the platform RLS
bypass with the internal business tenant scope and mapped `users.id`. No company endpoint accepts
a business id.

Opening an app creates a two-minute, one-use staff handoff. Redemption rechecks the admin,
company mapping, business and tenant membership, then creates a normal host-scoped tenant session
for that real membership. It is not customer impersonation and creates no impersonation grant.
Revocation (`is_active`) and preset changes take effect on the next company API call or handoff.

Presets: company owner, finance, sales/customer success, marketing, website editor and project
manager. The company home includes owner-only assignment/revocation controls. Presets are persisted
as exact tenant permission overrides, so existing tenant sessions observe changes immediately;
revocation also deactivates the mapped tenant user. Infrastructure role capabilities are not
consulted for business operations.

## Billing posting rules

Billing Control Center remains authoritative. Database triggers transactionally append only new
source transitions to `platform_company_billing_events`; migration/setup does **not** backfill old
sources.

| Billing fact | Debit | Credit |
|---|---|---|
| Invoice issued | A/R 1200 | Subscription/usage income 4500 |
| Invoice payment/partial allocation | Bank 1110 | A/R 1200 |
| Invoice void/credit | Sales returns 4400 | A/R 1200 |
| Wallet top-up | Bank 1110 | Customer wallet liability 2455 |
| Wallet spend without an invoice | Wallet liability 2455 | Subscription/usage income 4500 |
| Invoice settled from wallet | Wallet liability 2455 | A/R 1200 |
| Partial refund credited to wallet | Sales returns 4400 | Wallet liability 2455 |
| Promotional/noncash credit | No posting; retained as an ignored reconciliation event |
| Authoritative provider cost | Hosting/storage/messaging cost 5670 | A/P 2100 |

Unique source versions and unique posting references make delivery and posting idempotent. Events
are ordered by occurrence, retried with backoff, and stale processing leases recover. A customer
mapping and every account mapping must exist before a customer event posts; missing mappings stay
visible as failed events. The Accounting page exposes status and authorized retry. The bridge creates a legal-party/customer
mapping from the platform directory name on first authoritative billing event, under a per-customer
transaction lock. It never reads the customer tenant's CRM, contacts, documents or ledger. CRM's
read-only balance endpoint derives balances only from successfully posted Accounting events.

MRR and similar Billing metrics are operational metrics. They are not labelled as posted revenue.
A won deal or completed project never posts revenue.

## Website lead intake

Website editors create or rotate a show-once credential from the Websites page. Each credential is
bound to one `site_key` and either `eshobe` or `wordpress`; it has no tenant read permission.
Forms submit a bounded JSON body to `POST /api/website/leads` with `Authorization: Bearer …` and an
`Idempotency-Key` header. The endpoint validates contact data, normalizes Iranian phone numbers,
uses a honeypot, applies a durable per-credential minute limit, records attribution and the consent
snapshot, and creates one CRM lead. Retries return the original identifiers without duplicate CRM
records. Marketing consent is recorded but does not itself activate or send a campaign.

## Historical data and rollback

Dry-run historical discovery:

```bash
npm run platform-company:billing-backfill -- --cutoff=2026-09-30T23:59:59Z
```

Explicit enqueue (never run as part of deployment):

```bash
npm run platform-company:billing-backfill -- --cutoff=2026-09-30T23:59:59Z --apply
```

Duplicate source keys make repeated runs safe. To disable rollout, deactivate company memberships
or entitlements and stop the worker. Keep pending/failed events for recovery. Do not delete posted
journal entries; use normal reversing accounting documents.

## Canonical routes

- `/platform/company`
- `/platform/company/workspace`
- `/platform/company/accounting`
- `/platform/company/crm`
- `/platform/company/growth`
- `/platform/company/websites`

The app pages hand off to the existing shared engines. Technical Connections remains the profile
hub. No quick-reports dashboard or duplicate AI menu was introduced.

## Confirmed defects fixed in this implementation

- `src/lib/platform-service.ts`: customer directory and acquisition counts included every business;
  the protected internal company is now excluded.
- `src/lib/subscription-service.ts`: generic renewal could suspend any business with a subscription
  row; ownership is now checked both in direct renewal and the scheduler query.
- `src/app/api/platform/businesses/[id]/route.ts`: reset/delete/lifecycle endpoints had no protected
  ownership policy; internal-company mutations now fail with `protected_internal_business`.
- `src/app/api/platform/billing/overview/route.ts`: customer commercial KPIs had no ownership filter;
  internal activity is no longer counted as customer revenue, wallets or acquisition.
- Workspace project creation had no durable external idempotency key. `creation_key` now prevents a
  retried CRM deal handoff from creating duplicate projects.

No route or helper in this affected scope was verified as dead, so none was deleted merely from a
text search. Existing customer routes remain compatible.
